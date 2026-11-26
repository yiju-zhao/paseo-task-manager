export const LLM_ROLES = ['digest', 'curate', 'restage'] as const;
export const CREDENTIAL_MODES = ['login', 'oauth_token', 'api_key'] as const;

export type StewardModel = { provider: 'claude'; model: string };
