-- external-dns DNSEndpoint: the CRD source records the generation it last
-- reconciled in status.observedGeneration. Healthy once that has caught up
-- with metadata.generation (or when either side is missing, since older
-- external-dns releases never write status); Progressing while it lags.
hs = {}
hs.status = "Healthy"
hs.message = "DNSEndpoint observed by external-dns"
local generation = nil
if obj.metadata ~= nil then
  generation = obj.metadata.generation
end
local observed = nil
if obj.status ~= nil then
  observed = obj.status.observedGeneration
end
if generation == nil or observed == nil then
  hs.message = "No generation information; assuming reconciled"
elseif observed < generation then
  hs.status = "Progressing"
  hs.message = "Waiting for external-dns to observe generation " .. tostring(generation) .. " (observed " .. tostring(observed) .. ")"
end
return hs
