-- How much of each call's output was thinking (usage.output_tokens_details.thinking_tokens, ai-pipeline §9.2). Thinking
-- is billed as output and is most of it on the slow generation tasks, so the dashboard needs it to see where time and
-- money go. Null for rows written before this column and for responses that do not report it.
alter table public.ai_usage
  add column thinking_tokens int check (thinking_tokens is null or thinking_tokens >= 0);
