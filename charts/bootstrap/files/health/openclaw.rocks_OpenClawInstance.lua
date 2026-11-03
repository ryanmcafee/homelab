-- openclaw.rocks OpenClawInstance: the operator publishes a lifecycle phase in
-- status.phase (Pending, Provisioning, Running, Degraded, Failed, Terminating,
-- BackingUp, Restoring, Updating, Suspended) and a Ready condition.
--
-- Running alone is not enough to call the Instance Healthy: the operator keeps
-- the phase at Running while Ready goes False (a crash-looping agent container,
-- a Secret it cannot read), which is exactly the "green in ArgoCD, degraded
-- underneath" case. Running therefore requires Ready to be absent or True.
hs = {}
hs.status = "Progressing"
hs.message = "Waiting for the OpenClawInstance to report a phase"

local ready = nil
if obj.status ~= nil and obj.status.conditions ~= nil then
  for _, condition in ipairs(obj.status.conditions) do
    if condition.type == "Ready" then
      ready = condition
    end
  end
end

if obj.status ~= nil and obj.status.phase ~= nil then
  local phase = obj.status.phase
  if phase == "Running" then
    if ready ~= nil and ready.status == "False" then
      hs.status = "Degraded"
      hs.message = "Instance is running but not ready"
    else
      hs.status = "Healthy"
      hs.message = "Instance is running"
    end
  elseif phase == "Degraded" or phase == "Failed" then
    hs.status = "Degraded"
    hs.message = "Instance is in phase " .. phase
  elseif phase == "Suspended" then
    -- spec.suspended is a deliberate operator action, not a failure to wait on.
    hs.status = "Suspended"
    hs.message = "Instance is suspended"
  else
    hs.message = "Instance is in phase " .. phase
  end
  -- The status has no top-level message field; detail only ever comes from Ready.
  if ready ~= nil and ready.message ~= nil and ready.message ~= "" then
    hs.message = hs.message .. ": " .. ready.message
  end
end
return hs
