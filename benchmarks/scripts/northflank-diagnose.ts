import fs from 'node:fs';

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

const snapshots: { step: string; status: number; body: unknown }[] = [];

async function rawApi(path: string, init?: RequestInit) {
  const res = await fetch(`https://api.northflank.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
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

function summarizeBody(body: unknown, max = 500): string {
  const text = JSON.stringify(body);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

async function snapshot(step: string, path: string, init?: RequestInit) {
  const { status, body } = await rawApi(path, init);
  snapshots.push({ step, status, body });
  console.log(`${step}: ${status}`);
  console.log(`  body: ${summarizeBody(body)}`);
  return { status, body };
}

function decodeTokenClaims(jwt: string): Record<string, unknown> | undefined {
  const parts = jwt.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function main() {
  if (!token || !projectId) {
    console.error('NORTHFLANK_TOKEN and NORTHFLANK_PROJECT_ID must be set');
    process.exit(1);
  }

  const claims = decodeTokenClaims(token);
  if (claims) {
    console.log(`Token claim keys: ${Object.keys(claims).join(', ')}`);
    for (const key of ['entityId', 'entityType', 'type', 'roleId', 'roleEntityId', 'roleEntityType', 'roleInternalId']) {
      if (claims[key] !== undefined) {
        const value = typeof claims[key] === 'string' ? `${(claims[key] as string).slice(0, 8)}...` : JSON.stringify(claims[key]);
        console.log(`  ${key}: ${value}`);
      }
    }
  } else {
    console.log('Token is not a JWT or could not be decoded');
  }

  await snapshot('/v1/plans', '/v1/plans');
  await snapshot('/v1/projects/{projectId}', `/v1/projects/${projectId}`);

  if (claims?.roleEntityType === 'team' && typeof claims.roleEntityId === 'string') {
    const inferredTeamId = claims.roleEntityId;
    console.log('Token is team-scoped; trying team-scoped project endpoints');
    await snapshot('/v1/teams/{roleEntityId}/projects/{projectId}', `/v1/teams/${inferredTeamId}/projects/${projectId}`);
    await snapshot('/v1/teams/{roleEntityId}/projects/{projectId}/services', `/v1/teams/${inferredTeamId}/projects/${projectId}/services`);
  }

  const projectsList = await rawApi('/v1/projects');
  snapshots.push({ step: '/v1/projects (full response)', status: projectsList.status, body: projectsList.body });
  const personalProjects = projectsFrom(projectsList.body);
  console.log(`Personal projects total: ${personalProjects.length}`);
  const matching = personalProjects.filter((p) => p.id === projectId);
  console.log(`Personal projects matching NORTHFLANK_PROJECT_ID: ${matching.length}`);
  if (matching.length > 0) {
    console.log(`  matched project: ${JSON.stringify(matching[0])}`);
  }

  const teamsList = await rawApi('/v1/teams');
  snapshots.push({ step: '/v1/teams (full response)', status: teamsList.status, body: teamsList.body });
  const teams = teamsFrom(teamsList.body);
  console.log(`Teams total: ${teams.length}`);

  for (const team of teams) {
    const teamProjectsRes = await rawApi(`/v1/teams/${team.id}/projects`);
    snapshots.push({ step: `/v1/teams/${team.id}/projects`, status: teamProjectsRes.status, body: teamProjectsRes.body });
    const teamProjects = projectsFrom(teamProjectsRes.body);
    const match = teamProjects.find((p) => p.id === projectId);
    if (match) {
      console.log(`Found project in team: ${team.name ?? '(no name)'} (id: ${team.id})`);
      const teamProject = await rawApi(`/v1/teams/${team.id}/projects/${projectId}`);
      snapshots.push({ step: `/v1/teams/${team.id}/projects/${projectId}`, status: teamProject.status, body: teamProject.body });
      console.log(`/v1/teams/${team.id}/projects/${projectId}: ${teamProject.status}`);
      console.log(`  body: ${summarizeBody(teamProject.body)}`);
    }
  }

  await snapshot('/v1/projects/{projectId}/services', `/v1/projects/${projectId}/services`);
  await snapshot('/v1/projects/{projectId}/services/deployment (POST)', `/v1/projects/${projectId}/services/deployment`, {
    method: 'POST',
    body: JSON.stringify({
      name: `computesdk-diagnostic-${Date.now()}`,
      billing: { deploymentPlan: 'nf-compute-10' },
      deployment: {
        instances: 1,
        docker: { configType: 'customCommand', customCommand: 'sleep infinity' },
      },
    }),
  });

  fs.mkdirSync('/tmp/northflank-diagnostic', { recursive: true });
  fs.writeFileSync('/tmp/northflank-diagnostic/responses.json', JSON.stringify(snapshots, null, 2));
  console.log('Wrote full response artifact to /tmp/northflank-diagnostic/responses.json');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
