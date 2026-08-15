/**
 * Prime's public CLI routes ordinary RPC invocations through its resident
 * daemon. Supplying a process-local extension factory through the public
 * `main()` embedding API deliberately selects the in-process runtime instead.
 * The no-op factory adds no tool or state; Weaver's authenticated submission
 * extension is still the sole explicit extension path in the CLI arguments.
 */
const moduleUrl = process.env.WEAVER_PRIME_AGENT_MODULE_URL;
if (!moduleUrl) throw new Error('WEAVER_PRIME_AGENT_MODULE_URL is not configured');
const { main } = await import(moduleUrl);

await main(process.argv.slice(2), { extensionFactories: [() => undefined] });
