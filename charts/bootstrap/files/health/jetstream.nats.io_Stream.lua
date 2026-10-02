-- NACK reconciles a jetstream.nats.io Stream into a real stream on the NATS
-- server and reports the outcome as condition Ready. With no script for the
-- kind ArgoCD has no health for it at all, so it calls the resource Healthy the
-- moment it is applied and nats-config goes green whether or not the stream
-- exists: an overlapping-subject rejection (10065) or a replica count the
-- cluster cannot satisfy (10074) would never surface.
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
        hs.message = messageOr(condition, "Stream created on the NATS server")
      elseif condition.status == "False" then
        hs.status = "Degraded"
        hs.message = messageOr(condition, "NACK could not reconcile the stream")
      else
        hs.message = messageOr(condition, "Ready condition is Unknown")
      end
    end
  end
end

-- A retention or subject edit NACK has not observed yet still carries the
-- previous generation's Ready=True, which would report the old stream as the
-- new one. Trust the condition only once the controller has caught up.
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
