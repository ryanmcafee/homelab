-- HTTPRoute: Degraded when a Gateway rejects it or cannot resolve its backend;
-- Healthy otherwise, also before any Gateway has written status. Routes sync
-- before their Gateway exists (argocd at bootstrap wave 1, Gateways at addons
-- wave 6), so waiting for status, as the built-in check does, would deadlock.
hs = {}
hs.status = "Healthy"
hs.message = "Waiting for the Gateway to accept the route (non-blocking)"
local generation = nil
if obj.metadata ~= nil then
  generation = obj.metadata.generation
end
if obj.status == nil or obj.status.parents == nil then
  return hs
end
local accepted = 0
for _, parent in ipairs(obj.status.parents) do
  local name = ""
  if parent.parentRef ~= nil and parent.parentRef.name ~= nil then
    name = parent.parentRef.name
  end
  if parent.conditions ~= nil then
    for _, condition in ipairs(parent.conditions) do
      local current = generation == nil or condition.observedGeneration == nil or condition.observedGeneration == generation
      if current and (condition.type == "Accepted" or condition.type == "ResolvedRefs") then
        if condition.status == "False" then
          hs.status = "Degraded"
          hs.message = "Gateway " .. name .. ": " .. condition.type .. " is False"
          if condition.message ~= nil and condition.message ~= "" then
            hs.message = hs.message .. ": " .. condition.message
          end
          return hs
        end
        if condition.type == "Accepted" and condition.status == "True" then
          accepted = accepted + 1
        end
      end
    end
  end
end
if accepted > 0 then
  hs.message = "Accepted by " .. accepted .. " Gateway(s)"
end
return hs
