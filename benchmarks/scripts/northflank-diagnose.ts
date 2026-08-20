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
    for (const key of ['sub', 'team', 'teamId', 'org', 'orgId', 'scope', 'scopes', 'role', 'aud']) {
      if (claims[key] !== undefined) {
        console.log(`  ${key}: ${JSON.stringify(claims[key])}`);
      }
    }
  } else {
    console.log('Token is not a JWT or could not be decoded');
  }

  const plans = await rawApi('/v1/plans');
  console.log(`/v1/plans: ${plans.status}`);

  const direct = await rawApi(`/v1/projects/${projectId}`);
  console.log(`/v1/projects/${projectId}: ${direct.status}`);
  console.log(`  body: ${summarizeBody(direct.body)}`);

  const projectsList = await rawApi('/v1/projects');
  const personalProjects = projectsFrom(projectsList.body);
  console.log(`Personal projects total: ${personalProjects.length}`);
  const matching = personalProjects.filter((p) => p.id === projectId);
  console.log(`Personal projects matching NORTHFLANK_PROJECT_ID: ${matching.length}`);
  if (matching.length > 0) {
    console.log(`  matched project: ${JSON.stringify(matching[0])}`);
  }

  const teamsList = await rawApi('/v1/teams');
  const teams = teamsFrom(teamsList.body);
  console.log(`Teams total: ${teams.length}`);

  for (const team of teams) {
    const teamProjectsRes = await rawApi(`/v1/teams/${team.id}/projects`);
    const teamProjects = projectsFrom(teamProjectsRes.body);
    const match = teamProjects.find((p) => p.id === projectId);
    if (match) {
      console.log(`Found project in team: ${team.name ?? '(no name)'} (id: ${team.id})`);
      const teamProject = await rawApi(`/v1/teams/${team.id}/projects/${projectId}`);
      console.log(`/v1/teams/${team.id}/projects/${projectId}: ${teamProject.status}`);
      console.log(`  body: ${summarizeBody(teamProject.body)}`);
    }
  }

  const services = await rawApi(`/v1/projects/${projectId}/services`);
  console.log(`/v1/projects/${projectId}/services: ${services.status}`);
  console.log(`  body: ${summarizeBody(services.body)}`);

  const createRes = await rawApi(`/v1/projects/${projectId}/services/deployment`, {
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
  console.log(`/v1/projects/${projectId}/services/deployment (POST): ${createRes.status}`);
  console.log(`  body: ${summarizeBody(createRes.body)}`);

  const serviceId =
    createRes.status === 200 &&
    createRes.body &&
    typeof createRes.body === 'object' &&
    (createRes.body as Record<string, unknown>).data &&
    typeof (createRes.body as Record<string, unknown>).data === 'object'
      ? ((createRes.body as Record<string, unknown>).data as Record<string, unknown>).id
      : undefined;
  if (typeof serviceId === 'string') {
    console.log(`Created diagnostic service ${serviceId}; cleaning up...`);
    const deleteRes = await rawApi(`/v1/projects/${projectId}/services/${serviceId}`, { method: 'DELETE' });
    console.log(`DELETE service: ${deleteRes.status}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
