import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { synthDbAdmin } from './support/harness';

// The db-admin task is the only thing that sets database role passwords; each
// password reaches it from Secrets Manager as an env var, never a file or the CLI.

type ContainerDef = {
  Name: string;
  Secrets?: Array<{ Name: string; ValueFrom: unknown }>;
};

describe('DbAdminStack — personal login role', () => {
  const { template } = synthDbAdmin();

  const admin = (): ContainerDef => {
    const c = Object.values(template.findResources('AWS::ECS::TaskDefinition'))
      .flatMap((td) => (td as any).Properties.ContainerDefinitions as ContainerDef[])
      .find((x) => x.Name === 'dbadmin');
    assert.ok(c, 'no dbadmin container');
    return c;
  };

  test('admin task reads the personal role password from its own secret', () => {
    const s = (admin().Secrets ?? []).find((x) => x.Name === 'PERSONAL_DB_PASSWORD');
    assert.ok(s, 'PERSONAL_DB_PASSWORD not injected');
    const from = JSON.stringify(s.ValueFrom);
    assert.match(from, /:secret:bryan-test\/db\/personal/);
    assert.match(from, /:DB_PASSWORD::/);
  });
});
