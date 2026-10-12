import { EventEmitter } from 'node:events';
import { describe, it, expect } from 'test-anywhere';
import { refreshGhCliToken } from '../src/github/token.js';

describe('gh authentication refresh process', () => {
  it('requests the organization scope and sends authentication prompts to stderr', async () => {
    const invocations = [];
    const result = await refreshGhCliToken({
      interactive: true,
      readCliToken: () => 'refreshed',
      spawnCommand: (...args) => {
        invocations.push(args);
        const child = new EventEmitter();
        Promise.resolve().then(() => child.emit('close', 0));
        return child;
      },
    });
    expect(result).toBe('refreshed');
    expect(invocations).toEqual([
      [
        'gh',
        ['auth', 'refresh', '-h', 'github.com', '-s', 'admin:org'],
        { stdio: ['inherit', 2, 2] },
      ],
    ]);
  });

  it('avoids interactive authentication in unattended processes', async () => {
    expect(
      await refreshGhCliToken({
        interactive: false,
        spawnCommand: () => {
          throw new Error('must not start');
        },
      })
    ).toBe(null);
  });

  it('does not read tokens after a declined or unavailable authentication process', async () => {
    for (const event of ['close', 'error']) {
      expect(
        await refreshGhCliToken({
          interactive: true,
          readCliToken: () => {
            throw new Error('must not read');
          },
          spawnCommand: () => {
            const child = new EventEmitter();
            Promise.resolve().then(() =>
              child.emit(
                event,
                event === 'close' ? 1 : new Error('unavailable')
              )
            );
            return child;
          },
        })
      ).toBe(null);
    }
  });
});
