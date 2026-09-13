-- Ingress: treat as Healthy even without a loadBalancer address.
-- This prevents a circular dependency during the initial sync when Traefik
-- (which would populate status.loadBalancer) is not deployed yet.
hs = {}
hs.status = "Healthy"
hs.message = ""
if obj.status ~= nil then
  if obj.status.loadBalancer ~= nil then
    if obj.status.loadBalancer.ingress ~= nil then
      hs.message = "Load balancer ingress configured"
    else
      hs.message = "Waiting for load balancer (non-blocking)"
    end
  end
end
return hs
