-- paperclip.inc Instance: the operator publishes a coarse lifecycle phase in
-- status.phase. Running is Healthy, Failed/Error are Degraded, and anything
-- else (Pending, Provisioning, no status yet) is still Progressing.
hs = {}
hs.status = "Progressing"
hs.message = "Waiting for the Instance to report a phase"
if obj.status ~= nil and obj.status.phase ~= nil then
  local phase = obj.status.phase
  if phase == "Running" then
    hs.status = "Healthy"
    hs.message = "Instance is running"
  elseif phase == "Failed" or phase == "Error" then
    hs.status = "Degraded"
    hs.message = "Instance is in phase " .. phase
  else
    hs.message = "Instance is in phase " .. phase
  end
  if obj.status.message ~= nil and obj.status.message ~= "" then
    hs.message = hs.message .. ": " .. obj.status.message
  end
end
return hs
