#!/usr/bin/env bash
#
# Commit benchmark results to a temporary branch, open a pull request, and
# merge it. This works around repository rulesets that require changes via
# pull request while still landing results on the base branch automatically.
#
# Usage:
#   benchmarks/scripts/commit-results.sh <workflow-slug> <path>...
#
# GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_REF, GITHUB_RUN_ID, and
# GITHUB_RUN_ATTEMPT must be available in the environment.

set -euo pipefail

shopt -s nullglob

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <workflow-slug> <path>..." >&2
  exit 1
fi

slug="$1"
shift

if [ -z "${GITHUB_TOKEN:-}" ] || [ -z "${GITHUB_REPOSITORY:-}" ] || [ -z "${GITHUB_REF:-}" ]; then
  echo "GITHUB_TOKEN, GITHUB_REPOSITORY, and GITHUB_REF are required" >&2
  exit 1
fi

base_branch="${GITHUB_REF#refs/heads/}"
base_branch="${base_branch:-master}"
run_id="${GITHUB_RUN_ID:-unknown}"
run_attempt="${GITHUB_RUN_ATTEMPT:-1}"
branch="bench-results/${slug}/${run_id}-${run_attempt}"
title="chore: update benchmark results [skip ci]"
body="Automated benchmark results from workflow \`${slug}\` (run ${run_id}, attempt ${run_attempt})."

api_url="${GITHUB_API_URL:-https://api.github.com}"

# Resolve files to add. Arguments may contain globs; nullglob ensures an
# unmatched glob expands to nothing instead of a literal string.
files=()
for pattern in "$@"; do
  # shellcheck disable=SC2086
  for f in $pattern; do
    files+=("$f")
  done
done

if [ "${#files[@]}" -eq 0 ]; then
  echo "No files matched the provided patterns"
  exit 0
fi

git config user.name "github-actions[bot]"
git config user.email "github-actions[bot]@users.noreply.github.com"

if ! git add "${files[@]}"; then
  echo "Failed to stage files" >&2
  exit 1
fi

if git diff --cached --quiet; then
  echo "No changes to commit"
  exit 0
fi

git checkout -b "$branch"
git commit -m "$title"

# Fetch the latest base before pushing to minimize the chance the PR branch
# is behind. This handles the common stale checkout case.
git fetch origin "$base_branch"
git rebase "origin/$base_branch" || { git rebase --abort; exit 1; }

if ! git push origin "$branch"; then
  echo "Failed to push branch $branch" >&2
  exit 1
fi

# Create pull request
pr_resp=$(curl -sSL -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "$api_url/repos/$GITHUB_REPOSITORY/pulls" \
  -d "$(jq -n \
    --arg title "$title" \
    --arg body "$body" \
    --arg head "$branch" \
    --arg base "$base_branch" \
    '{title: $title, body: $body, head: $head, base: $base, maintainer_can_modify: false}')")

pr_number=$(echo "$pr_resp" | jq -r '.number // empty')
if [ -z "$pr_number" ]; then
  echo "Failed to create pull request: $(echo "$pr_resp" | jq -r '.message // . // empty')" >&2
  exit 1
fi

echo "Created pull request #$pr_number"

# Merge the pull request, retrying if the branch is out of date.
for attempt in 1 2 3 4 5; do
  merge_resp=$(curl -sSL -X PUT \
    -H "Authorization: Bearer $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$api_url/repos/$GITHUB_REPOSITORY/pulls/$pr_number/merge" \
    -d "$(jq -n \
      --arg title "$title" \
      '{commit_title: $title, merge_method: "rebase"}')")

  if [ "$(echo "$merge_resp" | jq -r '.merged // false')" = "true" ]; then
    echo "Merged pull request #$pr_number"
    exit 0
  fi

  msg=$(echo "$merge_resp" | jq -r '.message // empty')
  echo "Merge attempt $attempt failed: $msg" >&2

  # If the PR is behind the base, rebase and force-push the branch.
  if echo "$msg" | grep -qiE "not mergeable|merge conflict|head was modified|required status check|update branch|ahead|behind"; then
    git fetch origin "$base_branch"
    if git rebase "origin/$base_branch"; then
      if git push origin "$branch" --force-with-lease; then
        echo "Rebased and force-pushed; retrying merge"
        sleep 5
        continue
      fi
    else
      git rebase --abort || true
    fi
  fi

  sleep 5
done

echo "Failed to merge pull request #$pr_number" >&2
exit 1
