# Plugin System

The plugin system extends executable capabilities without allowing extensions to
replace workflow state transitions, approval enforcement, security decisions,
contract versioning or artifact-ledger integrity.

## Runtime levels

- Declarative extensions remain in Profiles, Routes, Cards, Schemas and Policies.
- Trusted TypeScript/JavaScript extensions use the in-process ESM host.
- Python, Rust, C# and untrusted Node extensions use the versioned JSON-RPC boundary.
- External systems use MCP, HTTP or gRPC adapters. The package defines the boundary
  without forcing one transport SDK on every consumer.

In-process permissions are an auditable host-service contract, not a sandbox.
Plugins that require isolation must not be loaded through `host-node`.
The process boundary uses JSON-RPC 2.0 plus an independent protocol version and
the fixed `plugin.describe`, `plugin.activate`, `plugin.deactivate` and
`service.invoke` method set.

## Trusted ESM plugin

```ts
import {
  definePlugin,
  sourceProviderService,
  type SourceProviderService,
} from '@gk0919/agent-workflow/plugin-sdk';

const provider: SourceProviderService = {
  id: 'example-source',
  async capture(request) {
    return {
      capturedAt: new Date().toISOString(),
      facts: { entry: request.entry },
      sourceId: request.reference ?? request.entry,
      sourceType: 'example',
    };
  },
};

export default definePlugin({
  manifest: {
    apiVersion: 1,
    capabilities: ['source-provider'],
    id: 'example-source',
    provides: { services: [sourceProviderService.id] },
    version: '1.0.0',
  },
  setup(context) {
    context.provide(sourceProviderService, provider);
  },
});
```

Configure it in `.agent-workflow/config.json`:

```json
{
  "plugins": [
    {
      "id": "example-source",
      "module": "@example/agent-workflow-source",
      "permissions": [],
      "options": {}
    }
  ]
}
```

Run `agent-workflow plugins:check` to load every enabled plugin, validate its
manifest and permissions, activate it in dependency order, then verify reverse
cleanup. A startup failure rolls back all effects from that activation attempt.
Normal CLI commands activate the host around command execution and emit only
`command:before` and `command:after` metadata; command arguments and user content
are intentionally excluded. Programmatic consumers resolve capability services
from `createNodePluginHost()`.

The package also includes a runnable MCP `source-provider` example and a generic
capture command. See
[`examples/mcp-source-provider/README.md`](../examples/mcp-source-provider/README.md)
for secure environment-variable authentication, route mapping and exact source
capture with `agent-workflow source:capture`.

## Contract rules

- A configured id must match the module Manifest id.
- `apiVersion`, capabilities, permissions, provided services and dependencies are
  validated before `setup` executes.
- A plugin may resolve only services declared in `requires.services` and may
  register only services declared in `provides.services`.
- Route extensions return candidates rather than selecting a route. Approval
  providers collect decisions rather than changing workflow state; the protected
  core performs both final decisions.
- Permission-bearing host services require both a Manifest request and an explicit
  project grant.
- Events run serially. Service registrations, subscriptions and `context.effect`
  cleanups are reversed in last-in-first-out order.
- Plugin and service dependency cycles fail before any setup code runs.
