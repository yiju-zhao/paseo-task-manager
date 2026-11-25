# Task manager for Paseo

Choose which Paseo hosts contribute sessions to your agent-pm project board. The plugin runs the center, web board and MCP endpoint in its own process and continues collecting when the app is closed.

The collector reads sessions on the local daemon and hosts registered with that daemon. It stores session metadata, conversations and bounded tool details in the local center. That center may use its own model provider to summarize the conversations. Each source resumes from the last position acknowledged by the center.

## Setup

Use Paseo 0.17 or later and Node 26 or later. Install from the plugin directory in a prepared local checkout. Each daemon has its own private configuration, credentials and database identity record. New configurations listen on loopback. See the [setup guide](README.md).

## Collection settings

Select individual hosts or all known hosts. By default, closed and archived sessions contribute metadata only. You can opt into reading their history and watch the import progress in settings. Reading a stored session can load its provider runtime. Archived sessions retain their archive status.

The trusted plugin uses the daemon account's filesystem and network access to read its configuration, store locks, cache and pending batches, inspect repository state and send data to the center. Repository changes are reported as counts. If the optional checkout API is unavailable, session collection continues. The plugin sends no prompts to agents.
