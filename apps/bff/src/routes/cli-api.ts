/** External CLI API boundary; individual resources compose this plugin without website queue routes. */
export {
  CLI_API_SCHEMA_VERSION,
  type CliApiOptions,
  type CliEnvelope,
  type CliError,
  type CliSuccess,
  type CliTokenRateLimiter,
  cliApiRoutes,
  cliError,
  cliSuccess,
  createCliTokenRateLimiter,
  translateCliError,
} from '../lib/cli-api'
