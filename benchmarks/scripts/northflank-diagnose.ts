interface Project {
  id: string;
  name?: string;
}

interface Team {
  id: string;
  name?: string;
}

const token = process.env.NORTHFLANK_TOKEN;
const projectId = process.env.NORTHFLANK_PROJECT_ID;

async function api(path: string) {
  const res = await fetch(`https://api.northflank.com${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  return { status: res.status, body };
}

function projectsFrom(body: unknown): Project[] {
  if (!body || typeof body !== 'object') return [];
  const anyBody = body as Record<string, unknown>;
  const data = anyBody.data as Record<string, unknown> | undefined;
  return ((data?.projects ?? anyBody.projects) as Project[] | undefined) ?? [];
}

function teamsFrom(body: unknown): Team[] {
  if (!body || typeof body !== 'object') return [];
  const anyBody = body as Record<string, unknown>;
  const data = anyBody.data as Record<string, unknown> | undefined;
  return ((data?.teams ?? anyBody.teams) as Team[] | undefined) ?? [];
}

async function main() {
  if (!token || !projectId) {
    console.error('NORTHFLANK_TOKEN and NORTHFLANK_PROJECT_ID must be set');
    process.exit(1);
  }

  const plans = await api('/v1/plans');
  console.log(`/v1/plans: ${plans.status}`);

  const direct = await api(`/v1/projects/${projectId}`);
  console.log(`/v1/projects/${projectId}: ${direct.status}`);

  const projectsList = await api('/v1/projects');
  const personalProjects = projectsFrom(projectsList.body);
  console.log(`Personal projects total: ${personalProjects.length}`);
  console.log(
    `Personal projects matching NORTHFLANK_PROJECT_ID: ${personalProjects.filter((p) => p.id === projectId).length}`,
  );

  const teamsList = await api('/v1/teams');
  const teams = teamsFrom(teamsList.body);
  console.log(`Teams total: ${teams.length}`);

  for (const team of teams) {
    const teamProjectsRes = await api(`/v1/teams/${team.id}/projects`);
    const teamProjects = projectsFrom(teamProjectsRes.body);
    const match = teamProjects.find((p) => p.id === projectId);
    if (match) {
      console.log(`Found project in team: ${team.name ?? '(no name)'} (id: ${team.id})`);
      const teamProject = await api(`/v1/teams/${team.id}/projects/${projectId}`);
      console.log(`/v1/teams/${team.id}/projects/${projectId}: ${teamProject.status}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
