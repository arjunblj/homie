import * as p from '@clack/prompts';

export interface InitEnv extends NodeJS.ProcessEnv {
  OPENHOMIE_AGENT_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  OPENAI_API_KEY?: string;
  MPP_PRIVATE_KEY?: string;
  MPP_RPC_URL?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_OPERATOR_USER_ID?: string;
  SIGNAL_DAEMON_URL?: string;
  SIGNAL_NUMBER?: string;
  SIGNAL_OPERATOR_NUMBER?: string;
}

export const cancelInit = (msg?: string): never => {
  p.cancel(msg ?? 'Setup cancelled.');
  process.exit(0);
};

export const failInit = (msg: string): never => {
  p.cancel(msg);
  process.exit(1);
};

export const guard = <T>(value: T | symbol): T => {
  if (p.isCancel(value)) cancelInit();
  return value as T;
};
