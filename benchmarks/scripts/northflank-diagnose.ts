import { ApiClient, ApiClientInMemoryContextProvider } from '@northflank/js-client';

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

async function rawApi(path: string) {
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

function buildClient() {
  const ctx = new ApiClientInMemoryContextProvider();
  ctx.addContext({ name: 'diagnostic', token: token!, host: 'https://api.northflank.com' });
  ctx.useContext('diagnostic');
  return new ApiClient(ctx, { throwErrorOnHttpErrorCode: false });
}

async function main() {
  if (!token || !projectId) {
    console.error('NORTHFLANK_TOKEN and NORTHFLANK_PROJECT_ID must be set');
    process.exit(1);
  }

  const plans = await rawApi('/v1/plans');
  console.log(`/v1/plans: ${plans.status}`);

  const direct = await rawApi(`/v1/projects/${projectId}`);
  console.log(`/v1/projects/${projectId}: ${direct.status}`);
  console.log(`  body: ${JSON.stringify(direct.body).slice(0, 500)}`);

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
    }
  }

  const client = buildClient();

  console.log('--- js-client calls ---');
  try {
    const getProject = await client.get.project({ parameters: { projectId } });
    console.log(`client.get.project: ${getProject.rawResponse.status}`);
  } catch (error) {
    console.log(`client.get.project threw: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const listServices = await client.list.services({ parameters: { projectId } });
    console.log(`client.list.services: ${listServices.rawResponse.status}`);
  } catch (error) {
    console.log(`client.list.services threw: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const createRes = await client.create.service.deployment({
      parameters: { projectId },
      data: {
        name: `computesdk-diagnostic-${Date.now()}`,
        billing: { deploymentPlan: 'nf-compute-10' },
        deployment: {
          instances: 1,
          docker: { configType: 'customCommand', customCommand: 'tail -f /dev/null' },
        },
      },
    });
    console.log(`client.create.service.deployment: ${createRes.rawResponse.status}`);
    if (createRes.data?.id) {
      console.log(`  created service ${createRes.data.id}; cleaning up...`);
      try {
        await client.delete.service({ parameters: { projectId, serviceId: createRes.data.id } });
        console.log('  cleanup succeeded');
      } catch (error) {
        console.log(`  cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    console.log(`client.create.service.deployment threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
