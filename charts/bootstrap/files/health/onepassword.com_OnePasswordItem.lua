-- 1Password Connect operator OnePasswordItem: Healthy once the operator has
-- materialised the Secret (condition Ready=True), Degraded when the item could
-- not be fetched (Ready=False), Progressing until the operator reports either.
-- The operator often leaves condition.message empty, and "" is truthy in Lua,
-- so fall back explicitly instead of relying on `or`.
local function messageOr(condition, fallback)
  if condition.message ~= nil and condition.message ~= "" then
    return condition.message
  end
  return fallback
end

hs = {}
hs.status = "Progressing"
hs.message = "Waiting for the 1Password operator to report a Ready condition"
if obj.status ~= nil and obj.status.conditions ~= nil then
  for _, condition in ipairs(obj.status.conditions) do
    if condition.type == "Ready" then
      if condition.status == "True" then
        hs.status = "Healthy"
        hs.message = messageOr(condition, "Secret synced from 1Password")
      elseif condition.status == "False" then
        hs.status = "Degraded"
        hs.message = messageOr(condition, "1Password item could not be synced")
      else
        hs.message = messageOr(condition, "Ready condition is Unknown")
      end
    end
  end
end
return hs
