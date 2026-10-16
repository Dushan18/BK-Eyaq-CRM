import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function eventually(
  check: () => Promise<boolean>,
  timeout = 20000,
) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Condición de recuperación no alcanzada');
}

// Owns exactly one randomly named container. Never accepts a CRM container name.
export class IsolatedRedis {
  private readonly name = `crm-redis-recovery-${randomUUID()}`;
  private readonly owner = randomUUID();
  private created = false;
  url = '';

  private async docker(...args: string[]) {
    const result = await exec(process.env.TEST_DOCKER_BIN || 'docker', args, {
      timeout: 30000,
      windowsHide: true,
    });
    return result.stdout.trim();
  }

  private async assertOwned() {
    if (!this.created || !/^crm-redis-recovery-[a-f0-9-]{36}$/.test(this.name))
      throw new Error('Contenedor de pruebas inválido');
    const owner = await this.docker(
      'inspect',
      '--format',
      '{{index .Config.Labels "crm.test.owner"}}',
      this.name,
    );
    if (owner !== this.owner) throw new Error('Contenedor ajeno a esta prueba');
  }

  async create() {
    if (process.env.MESSAGING_REDIS_RESTART_INTEGRATION !== '1')
      throw new Error('Prueba Docker requiere opt-in explícito');
    // Reserve a currently free loopback port; Docker fails safely if raced.
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Puerto inválido');
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await this.docker(
      'create',
      '--pull=never',
      '--name',
      this.name,
      '--label',
      `crm.test.owner=${this.owner}`,
      '-p',
      `127.0.0.1:${port}:6379`,
      'redis:7.4-alpine',
      'redis-server',
      '--appendonly',
      'yes',
      '--appendfsync',
      'always',
      '--maxmemory-policy',
      'noeviction',
    );
    this.created = true;
    this.url = `redis://127.0.0.1:${port}/0`;
    await this.start();
  }

  async start() {
    await this.assertOwned();
    await this.docker('start', this.name);
    await eventually(async () => {
      try {
        return (
          (await this.docker('exec', this.name, 'redis-cli', 'ping')) === 'PONG'
        );
      } catch {
        return false;
      }
    });
  }

  async crash() {
    await this.assertOwned();
    await this.docker('kill', '--signal=KILL', this.name);
    const running = await this.docker(
      'inspect',
      '--format',
      '{{.State.Running}}',
      this.name,
    );
    if (running !== 'false') throw new Error('Redis de pruebas sigue activo');
  }

  async remove() {
    if (!this.created) return;
    await this.assertOwned();
    // Only this container and its anonymous, test-owned /data volume.
    await this.docker('rm', '-f', '-v', this.name);
    this.created = false;
  }
}
