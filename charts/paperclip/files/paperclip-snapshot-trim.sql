-- Keeps only message ids in settled runs' stored continuations (https://github.com/paperclipai/paperclip/issues/15543).
\set ON_ERROR_STOP on

select set_config('homelab.trim_min_age_hours', :'min_age_hours', false),
       set_config('homelab.trim_min_bytes', :'min_bytes', false),
       set_config('homelab.trim_batch_size', :'batch_size', false);

create function pg_temp.message_ids(messages jsonb) returns jsonb
language sql immutable as $$
  select case when jsonb_typeof(messages) = 'array' then (
    select coalesce(jsonb_agg(case when jsonb_typeof(message) = 'object'
                                   then jsonb_build_object('id', message -> 'id')
                                   else message end
                              order by ordinality), '[]'::jsonb)
    from jsonb_array_elements(messages) with ordinality as m(message, ordinality))
  else messages end
$$;

create function pg_temp.continuation_ids(continuation jsonb) returns jsonb
language sql immutable as $$
  select case when jsonb_typeof(continuation) <> 'object' then continuation else
    continuation
    || case when jsonb_typeof(continuation -> 'messages') = 'array'
            then jsonb_build_object('messages', pg_temp.message_ids(continuation -> 'messages'))
            else '{}'::jsonb end
    || case when jsonb_typeof(continuation -> 'resumeDelta' -> 'messages') = 'array'
            then jsonb_build_object('resumeDelta', (continuation -> 'resumeDelta')
                 || jsonb_build_object('messages', pg_temp.message_ids(continuation -> 'resumeDelta' -> 'messages')))
            else '{}'::jsonb end
  end
$$;

create function pg_temp.trimmed_snapshot(snapshot jsonb) returns jsonb
language sql immutable as $$
  select snapshot
    || case when jsonb_typeof(snapshot -> 'executionContinuation') = 'object'
            then jsonb_build_object('executionContinuation', pg_temp.continuation_ids(snapshot -> 'executionContinuation'))
            else '{}'::jsonb end
    || case when jsonb_typeof(snapshot -> 'paperclipWake' -> 'executionContinuation') = 'object'
            then jsonb_build_object('paperclipWake', (snapshot -> 'paperclipWake')
                 || jsonb_build_object('executionContinuation',
                      pg_temp.continuation_ids(snapshot -> 'paperclipWake' -> 'executionContinuation')))
            else '{}'::jsonb end
    || jsonb_build_object('homelabSnapshotTrimmedAt', to_jsonb(now()))
$$;

select pg_size_pretty(sum(pg_column_size(context_snapshot))::bigint) as context_snapshot_before
from heartbeat_runs;

do $$
declare
  min_age interval := make_interval(hours => current_setting('homelab.trim_min_age_hours')::int);
  min_bytes int := current_setting('homelab.trim_min_bytes')::int;
  batch_size int := current_setting('homelab.trim_batch_size')::int;
  batch_rows int;
  total_rows int := 0;
begin
  loop
    with batch as (
      select id from heartbeat_runs
      where status not in ('running', 'queued', 'scheduled_retry')
        and finished_at < now() - min_age
        and pg_column_size(context_snapshot) > min_bytes
        and not (context_snapshot ? 'homelabSnapshotTrimmedAt')
        and id not in (select last_run_id from agent_task_sessions where last_run_id is not null)
      limit batch_size
      for update skip locked
    )
    update heartbeat_runs run
    set context_snapshot = pg_temp.trimmed_snapshot(run.context_snapshot)
    from batch
    where run.id = batch.id;
    get diagnostics batch_rows = row_count;
    commit;
    total_rows := total_rows + batch_rows;
    exit when batch_rows = 0;
  end loop;
  raise notice 'trimmed context_snapshot of % settled runs', total_rows;
end
$$;

select pg_size_pretty(sum(pg_column_size(context_snapshot))::bigint) as context_snapshot_after
from heartbeat_runs;
