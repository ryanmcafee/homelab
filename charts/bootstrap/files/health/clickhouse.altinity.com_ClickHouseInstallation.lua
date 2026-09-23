-- clickhouse.altinity.com ClickHouseInstallation: the Altinity operator reports
-- its reconcile state in status.status. Completed is Healthy, Aborted is
-- Degraded, and InProgress, Terminating or no status yet are Progressing.
hs = {}
hs.status = "Progressing"
hs.message = "Waiting for the operator to reconcile the installation"
if obj.status ~= nil and obj.status.status ~= nil then
  local state = obj.status.status
  if state == "Completed" then
    hs.status = "Healthy"
    hs.message = "Installation reconciled"
  elseif state == "Aborted" then
    hs.status = "Degraded"
    hs.message = "Reconcile aborted"
  else
    hs.message = "Installation is " .. state
  end
  if obj.status.errors ~= nil and #obj.status.errors > 0 then
    hs.message = hs.message .. ": " .. obj.status.errors[#obj.status.errors]
  end
end
return hs
