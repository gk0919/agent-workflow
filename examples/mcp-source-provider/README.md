# MCP Source Provider Example

This example adapts exact requirement and defect references to the public
`SourceProviderService` contract. It uses the official MCP TypeScript client,
connects lazily over Streamable HTTP, reads a bearer token from an environment
variable and closes the MCP session with the plugin lifecycle.

The example intentionally does not contain a credential. Never store bearer
tokens in `.agent-workflow/config.json`, source files, shell history or Git.

## 1. Install the optional transport dependency

The workflow core does not force an MCP SDK on consumers. A project that enables
this example installs the optional peer explicitly:

```sh
pnpm add -D @gk0919/agent-workflow @modelcontextprotocol/client@^2.0.0
```

## 2. Configure the plugin

Merge the `plugins` item from [`config.example.json`](./config.example.json) into
the consuming project's `.agent-workflow/config.json`; preserve that project's
existing Profile and path settings.

The supplied company endpoint is plain HTTP, so the example requires the
deliberate `allowInsecureHttp: true` opt-in. Bearer credentials can be observed
on an untrusted HTTP network. Prefer an HTTPS endpoint when the service supports
one, and restrict this exception to the trusted company network.

The example maps:

| Source entry | MCP tool | Expected reference |
|---|---|---|
| `requirement` | `query_requirement` | `XQ...` |
| `defect` | `query_bug` | `BG...` |

At first capture, the provider calls `tools/list` and infers the reference
argument from each tool's `inputSchema`. If the schema has multiple plausible
parameters, add the actual parameter name to that route:

```json
{
  "tool": "query_requirement",
  "referenceArgument": "actual_parameter_name",
  "referencePattern": "^XQ"
}
```

Do not guess this value: read it from the MCP tool schema or the error's candidate
list.

## 3. Supply a rotated token at runtime

PowerShell, for the current process only:

```powershell
$env:JACKYUN_MCP_TOKEN = '<rotated-token>'
```

Bash-compatible shells:

```sh
export JACKYUN_MCP_TOKEN='<rotated-token>'
```

Use the raw token. A leading `Bearer ` is also accepted and normalized. The
provider never prints the token and asks the SDK for it immediately before each
request.

## 4. Validate and capture

`plugins:check` validates configuration and lifecycle without opening a network
connection because the provider connects lazily:

```sh
pnpm exec agent-workflow plugins:check
```

Capture one exact source and print bounded JSON facts:

```sh
pnpm exec agent-workflow source:capture --entry requirement --reference XQ123456
pnpm exec agent-workflow source:capture --entry defect --reference BG123456
```

Use `--provider mcp-source-provider` if multiple source providers are active,
and `--format json` for compact machine-readable output. Tool-level MCP errors,
missing routes, unexpected reference formats, ambiguous schemas, timeouts and
missing credentials fail closed with a non-zero exit code.

Only MCP text blocks and structured content are retained. Images and binary
blocks are intentionally excluded, and nested output, collections and text are
bounded before becoming workflow facts.
