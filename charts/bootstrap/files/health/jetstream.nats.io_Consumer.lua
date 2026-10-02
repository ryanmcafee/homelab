-- NACK reconciles a jetstream.nats.io Consumer into a durable consumer on the
-- NATS server and reports the outcome as condition Ready. Without a script for
-- the kind ArgoCD reports the resource Healthy on apply, so a consumer NACK
-- rejected -- a filterSubject outside the stream's subjects, or a durable whose
-- stream does not exist -- would read as a working subscriber with nothing
-- consuming the stream.
-- NACK often leaves condition.message empty, and "" is truthy in Lua, so fall
-- back explicitly instead of relying on `or`.
local function messageOr(condition, fallback)
  if condition.message ~= nil and condition.message ~= "" then
    return condition.message
  end
  return fallback
end

hs = {}
hs.status = "Progressing"
hs.message = "Waiting for NACK to report a Ready condition"
if obj.status ~= nil and obj.status.conditions ~= nil then
  for _, condition in ipairs(obj.status.conditions) do
    if condition.type == "Ready" then
      if condition.status == "True" then
        hs.status = "Healthy"
        hs.message = messageOr(condition, "Consumer created on the NATS server")
      elseif condition.status == "False" then
        hs.status = "Degraded"
        hs.message = messageOr(condition, "NACK could not reconcile the consumer")
      else
        hs.message = messageOr(condition, "Ready condition is Unknown")
      end
    end
  end
end

-- An ackWait or maxDeliver edit NACK has not observed yet still carries the
-- previous generation's Ready=True, which would report the old delivery
-- behaviour as the new one. Trust the condition only once it has caught up.
if
  hs.status == "Healthy"
  and obj.metadata ~= nil
  and obj.metadata.generation ~= nil
  and obj.status.observedGeneration ~= nil
  and obj.status.observedGeneration < obj.metadata.generation
then
  hs.status = "Progressing"
  hs.message = "Waiting for NACK to observe generation "
    .. tostring(obj.metadata.generation)
    .. " (observed "
    .. tostring(obj.status.observedGeneration)
    .. ")"
end

return hs
