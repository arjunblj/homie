import * as p from '@clack/prompts';
import pc from 'picocolors';

import { createBackend } from '../../backend/factory.js';
import type { IdentityPaths } from '../../identity/types.js';
import { BackendAdapter } from '../../interview/backendAdapter.js';
import {
  generateIdentity,
  type IdentityDraft,
  nextInterviewQuestion,
  refineIdentity,
} from '../../interview/index.js';
import type { InitProvider, ProviderAvailability } from '../../llm/detect.js';
import { fileExists } from '../../util/fs.js';
import { formatIdentityPreview } from './initFormat.js';
import { makeTempConfig } from './initHelpers.js';
import { isProviderUsable } from './initProviders.js';
import { type InterviewOperatorProfile, scoreIdentityDraft } from './initQuality.js';
import { cancelInit, failInit, guard, type InitEnv } from './initTypes.js';

const createReasoningReporter = (
  label: string,
): {
  onReasoningDelta: (delta: string) => void;
  stop: () => void;
} => {
  let raw = '';
  let printed = '';
  let timer: ReturnType<typeof setInterval> | null = null;
  const render = (): void => {
    const compact = raw.replace(/\s+/gu, ' ').trim();
    if (!compact || compact === printed) return;
    printed = compact;
    const preview = compact.length > 110 ? `${compact.slice(0, 110).trimEnd()}...` : compact;
    process.stdout.write(`\x1b[2K\r${pc.dim(`  -> ${label}: ${preview}`)}`);
  };
  return {
    onReasoningDelta: (delta: string) => {
      if (!delta) return;
      raw += delta;
      if (timer) return;
      timer = setInterval(render, 180);
    },
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (!raw.trim()) return;
      render();
      process.stdout.write('\n');
    },
  };
};

const askOptionalRichField = async (params: {
  message: string;
  placeholder?: string | undefined;
}): Promise<string | undefined> => {
  const raw = String(
    guard(
      await p.text({
        message: params.message,
        ...(params.placeholder ? { placeholder: params.placeholder } : {}),
      }),
    ),
  ).trim();
  if (!raw || raw.toLowerCase() === 'skip') return undefined;
  return raw;
};

const buildOperatorContextBlock = (
  profile: InterviewOperatorProfile | undefined,
  friendName: string,
): string => {
  if (!profile) return `FriendName: ${friendName}`;
  const lines = [
    `FriendName: ${friendName}`,
    `OperatorName: ${profile.operatorName ?? '(unknown)'}`,
    `RelationshipDynamic: ${profile.relationshipDynamic ?? '(unspecified)'}`,
    `BiographyDetails: ${profile.biographyDetails ?? '(unspecified)'}`,
    `TechnicalDetails: ${profile.technicalDetails ?? '(unspecified)'}`,
    `ConsistencyReferences: ${profile.consistencyReferences ?? '(none)'}`,
  ];
  return lines.join('\n');
};

export interface InterviewResult {
  identityDraft: IdentityDraft | null;
  operatorProfile: InterviewOperatorProfile | undefined;
  providerVerifiedViaInterview: boolean;
  overwriteIdentityFromInterview: boolean;
}

export async function runIdentityInterview(params: {
  shouldSkipInterview: boolean;
  defaultRunInterview?: boolean | undefined;
  provider: InitProvider;
  availability: ProviderAvailability;
  env: InitEnv;
  ollamaDetected: boolean;
  modelDefault: string;
  modelFast: string;
  idPaths: IdentityPaths;
}): Promise<InterviewResult> {
  const {
    shouldSkipInterview,
    defaultRunInterview,
    provider,
    availability,
    env,
    ollamaDetected,
    modelDefault,
    modelFast,
    idPaths,
  } = params;

  let identityDraft: IdentityDraft | null = null;
  let operatorProfile: InterviewOperatorProfile | undefined;
  let providerVerifiedViaInterview = false;
  let overwriteIdentityFromInterview = false;

  if (shouldSkipInterview) {
    p.log.warn('Skipping interview is recommended until MPP wallet funding is verified.');
  }
  const initialRunInterview =
    defaultRunInterview !== undefined ? defaultRunInterview : !shouldSkipInterview;
  const runInterview = guard(
    await p.confirm({ message: 'Run identity interview?', initialValue: initialRunInterview }),
  );

  if (!runInterview) {
    return {
      identityDraft,
      operatorProfile,
      providerVerifiedViaInterview,
      overwriteIdentityFromInterview,
    };
  }

  const isAiUsable = isProviderUsable(provider, availability, env, ollamaDetected);

  const friendName = guard(await p.text({ message: 'Friend name', initialValue: 'Homie' }));
  const collectOperatorProfile = guard(
    await p.confirm({
      message: 'Add operator relationship, bio, and technical context to improve identity quality?',
      initialValue: true,
    }),
  );
  if (collectOperatorProfile) {
    p.log.message(
      pc.dim(
        'Answer what you can. Type "skip" on any field to leave it blank and continue quickly.',
      ),
    );
    const operatorName = await askOptionalRichField({
      message: 'Operator name',
      placeholder: 'optional',
    });
    const relationshipDynamic = await askOptionalRichField({
      message: `How should ${friendName} relate to you (tone, boundaries, inside jokes)?`,
    });
    const biographyDetails = await askOptionalRichField({
      message: `Key biography details ${friendName} should know`,
      placeholder: 'history, place, family, life chapters',
    });
    const technicalDetails = await askOptionalRichField({
      message: `Technical context ${friendName} should understand`,
      placeholder: 'tools, domains, stack, workflows',
    });
    const consistencyReferences = await askOptionalRichField({
      message: 'Optional consistency references',
      placeholder: 'handles, sites, docs, or "skip"',
    });
    operatorProfile = {
      ...(operatorName ? { operatorName } : {}),
      ...(relationshipDynamic ? { relationshipDynamic } : {}),
      ...(biographyDetails ? { biographyDetails } : {}),
      ...(technicalDetails ? { technicalDetails } : {}),
      ...(consistencyReferences ? { consistencyReferences } : {}),
    };
    if (Object.keys(operatorProfile).length === 0) {
      operatorProfile = undefined;
    }
  }

  if (isAiUsable) {
    try {
      const tempConfig = makeTempConfig(provider, modelDefault, modelFast);
      const { backend } = await createBackend({ config: tempConfig, env });
      const client = new BackendAdapter(backend);

      const transcript: Array<{ role: 'user' | 'assistant'; content: string }> = [];
      const interviewUsage = {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        costUsd: 0,
        txHash: undefined as string | undefined,
      };
      const onInterviewUsage = (usage: {
        inputTokens?: number | undefined;
        outputTokens?: number | undefined;
        reasoningTokens?: number | undefined;
        costUsd?: number | undefined;
        txHash?: string | undefined;
      }): void => {
        interviewUsage.inputTokens += usage.inputTokens ?? 0;
        interviewUsage.outputTokens += usage.outputTokens ?? 0;
        interviewUsage.reasoningTokens += usage.reasoningTokens ?? 0;
        interviewUsage.costUsd += usage.costUsd ?? 0;
        if (usage.txHash) interviewUsage.txHash = usage.txHash;
      };
      if (operatorProfile) {
        transcript.push({
          role: 'assistant',
          content: 'operator_profile',
        });
        transcript.push({
          role: 'user',
          content: buildOperatorContextBlock(operatorProfile, friendName),
        });
      }
      let questionsAsked = 0;
      const targetQuestions = 12;

      p.log.step(pc.bold(`Getting to know ${friendName}`));
      p.log.message(
        pc.dim(`We'll ask ~${targetQuestions} questions to build ${friendName}'s personality.`),
      );
      p.log.message(
        pc.dim('Type "skip" for any question or press Enter on empty input to wrap up.'),
      );

      while (true) {
        const sp = p.spinner();
        const spinnerLabel =
          questionsAsked === 0
            ? 'Preparing your first question...'
            : `Considering your answer... (${questionsAsked}/${targetQuestions})`;
        sp.start(spinnerLabel);
        const reasoning = createReasoningReporter('thinking');
        try {
          const next = await nextInterviewQuestion(client, {
            friendName,
            questionsAsked,
            transcript: transcript.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n'),
            operatorContext: buildOperatorContextBlock(operatorProfile, friendName),
            onReasoningDelta: reasoning.onReasoningDelta,
            onUsage: onInterviewUsage,
          });
          reasoning.stop();
          if (next.done) {
            sp.stop(pc.dim(`Interview complete — ${questionsAsked} questions answered`));
            break;
          }
          const q = next.question.trim();
          if (!q) throw new Error('Interview model produced empty question');

          sp.stop(pc.dim(`Question ${questionsAsked + 1} of ~${targetQuestions}`));

          const a = String(
            guard(
              await p.text({
                message: q,
                placeholder: 'Type an answer, "skip", or press Enter to finish',
              }),
            ),
          ).trim();
          if (!a) {
            p.log.info(`Wrapping up after ${questionsAsked} questions.`);
            break;
          }
          const answer = a.toLowerCase() === 'skip' ? '[skipped by operator]' : a;
          transcript.push({ role: 'assistant', content: q });
          transcript.push({ role: 'user', content: answer });
          questionsAsked++;
          if (questionsAsked >= 15) {
            p.log.info(`All ${questionsAsked} questions answered — generating identity.`);
            break;
          }
        } catch (err) {
          reasoning.stop();
          sp.stop('Could not reach model');
          const msg = err instanceof Error ? err.message : String(err);
          p.log.error(`Interview error: ${msg}`);
          const action = guard(
            await p.select({
              message: 'What next?',
              options: [
                { value: 'retry', label: 'Retry this question' },
                { value: 'cancel', label: 'Cancel setup' },
              ],
            }),
          );
          if (action === 'cancel') cancelInit('Interview cancelled.');
        }
      }

      {
        const sp = p.spinner();
        sp.start(
          `Crafting ${friendName}'s identity from ${questionsAsked} answer${questionsAsked === 1 ? '' : 's'}...`,
        );
        const reasoning = createReasoningReporter('drafting identity');
        try {
          identityDraft = await generateIdentity(client, {
            friendName,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            transcript: transcript.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join('\n'),
            operatorContext: buildOperatorContextBlock(operatorProfile, friendName),
            onReasoningDelta: reasoning.onReasoningDelta,
            onUsage: onInterviewUsage,
            onProgress: (msg) => sp.message(msg),
          });
          reasoning.stop();
          sp.stop(`${friendName}'s identity is ready`);
          providerVerifiedViaInterview = true;

          p.note(formatIdentityPreview(identityDraft, friendName), `${friendName}'s identity`);

          while (true) {
            const quality = scoreIdentityDraft({
              draft: identityDraft,
              ...(operatorProfile ? { operatorProfile } : {}),
            });
            p.note(
              [
                `overall: ${quality.overall}/100 (${quality.passes ? 'pass' : 'needs refinement'})`,
                `specificity=${quality.breakdown.specificity} consistency=${quality.breakdown.consistency} depth=${quality.breakdown.depth}`,
                `uniqueness=${quality.breakdown.uniqueness} operatorCoverage=${quality.breakdown.operatorCoverage}`,
                ...(quality.issues.length > 0
                  ? ['', 'focus areas:', ...quality.issues.slice(0, 4).map((issue) => `- ${issue}`)]
                  : []),
              ].join('\n'),
              `${friendName} quality gate`,
            );
            const action = guard(
              await p.select({
                message: 'How does this look?',
                options: [
                  { value: 'accept', label: 'Looks good — save it' },
                  { value: 'refine', label: 'Refine — give feedback and regenerate' },
                ],
              }),
            );
            if (action === 'accept') {
              if (!quality.passes) {
                const forceAccept = guard(
                  await p.confirm({
                    message:
                      'Quality checks suggest this draft is weak. Save anyway without refining?',
                    initialValue: false,
                  }),
                );
                if (!forceAccept) {
                  continue;
                }
              }
              break;
            }

            const feedback = guard(
              await p.text({ message: 'What would you change? Be specific.' }),
            );

            const refSp = p.spinner();
            refSp.start('Refining identity...');
            const refineReasoning = createReasoningReporter('refining');
            try {
              identityDraft = await refineIdentity(client, {
                feedback,
                currentIdentity: identityDraft,
                onReasoningDelta: refineReasoning.onReasoningDelta,
                onUsage: onInterviewUsage,
              });
              refineReasoning.stop();
              refSp.stop('Identity updated');

              p.note(
                formatIdentityPreview(identityDraft, friendName),
                `${friendName}'s identity (refined)`,
              );
            } catch (err) {
              refineReasoning.stop();
              refSp.stop('Refinement failed');
              const msg = err instanceof Error ? err.message : String(err);
              p.log.warn(`Keeping previous draft. (${msg})`);
            }
          }
          const totalTokens = interviewUsage.inputTokens + interviewUsage.outputTokens;
          if (totalTokens > 0 || interviewUsage.costUsd > 0) {
            p.note(
              [
                `llm usage: in=${interviewUsage.inputTokens} out=${interviewUsage.outputTokens} reasoning=${interviewUsage.reasoningTokens}`,
                `estimated cost: $${interviewUsage.costUsd.toFixed(4)}`,
                ...(interviewUsage.txHash ? [`latest tx: ${interviewUsage.txHash}`] : []),
              ].join('\n'),
              'Interview run metrics',
            );
          }
        } catch (genErr) {
          reasoning.stop();
          sp.stop('Generation failed');
          const msg = genErr instanceof Error ? genErr.message : String(genErr);
          p.log.error(`Could not generate identity: ${msg}`);
          failInit('Identity generation failed. Check your provider and try again.');
        }
      }
    } catch (backendErr) {
      const msg = backendErr instanceof Error ? backendErr.message : String(backendErr);
      p.log.error(`Failed to initialize AI backend: ${msg}`);
      failInit(
        'Cannot run interview without a working LLM. Fix the provider and rerun homie init.',
      );
    }
  } else {
    p.log.error('No working provider detected. homie needs an LLM to generate identity files.');
    p.log.message(
      [
        `${pc.dim('Options:')}`,
        `  ${pc.green('→')} Install Claude Code CLI (${pc.cyan('npm i -g @anthropic-ai/claude-code')})`,
        `  ${pc.green('→')} Set ${pc.cyan('ANTHROPIC_API_KEY')} or ${pc.cyan('OPENROUTER_API_KEY')} in .env`,
        `  ${pc.green('→')} Start Ollama locally (${pc.cyan('ollama serve')})`,
        `  ${pc.green('→')} Set ${pc.cyan('MPP_PRIVATE_KEY')} for pay-per-use`,
        '',
        'Then rerun homie init.',
      ].join('\n'),
    );
    failInit('No LLM provider available.');
  }

  const existingIdentity = [
    idPaths.soulPath,
    idPaths.stylePath,
    idPaths.userPath,
    idPaths.firstMeetingPath,
    idPaths.personalityPath,
  ];
  const hasExistingIdentity = (
    await Promise.all(existingIdentity.map(async (fp) => fileExists(fp)))
  ).some(Boolean);
  if (hasExistingIdentity) {
    overwriteIdentityFromInterview = guard(
      await p.confirm({
        message: 'Identity files already exist. Overwrite with interview output?',
        initialValue: false,
      }),
    );
  } else {
    overwriteIdentityFromInterview = true;
  }

  return {
    identityDraft,
    operatorProfile,
    providerVerifiedViaInterview,
    overwriteIdentityFromInterview,
  };
}
