-- Tailscale operator Connector: the operator sets a single ConnectorReady
-- condition (the only known type on the v1alpha1 CRD). Healthy on True,
-- Degraded on False, Progressing until the operator has reconciled it.
-- The operator sets condition.message to "" on success, and "" is truthy in
-- Lua, so fall back explicitly instead of relying on `or`.
local function messageOr(condition, fallback)
  if condition.message ~= nil and condition.message ~= "" then
    return condition.message
  end
  return fallback
end

hs = {}
hs.status = "Progressing"
hs.message = "Waiting for the Tailscale operator to report ConnectorReady"
if obj.status ~= nil and obj.status.conditions ~= nil then
  for _, condition in ipairs(obj.status.conditions) do
    if condition.type == "ConnectorReady" then
      if condition.status == "True" then
        hs.status = "Healthy"
        hs.message = messageOr(condition, "Connector is ready")
        if obj.status.hostname ~= nil and obj.status.hostname ~= "" then
          hs.message = hs.message .. " (" .. obj.status.hostname .. ")"
        end
      elseif condition.status == "False" then
        hs.status = "Degraded"
        hs.message = messageOr(condition, "Connector is not ready")
      else
        hs.message = messageOr(condition, "ConnectorReady condition is Unknown")
      end
    end
  end
end
return hs
