# IoT weather and soil sensors: the freshness SLO and the alerts that cover it

The Ecowitt gateway (WH2650/GW1100 family) pushes readings over HTTP to
`ecowitt-exporter`, which turns them into Prometheus series. Nothing polls the
station: the exporter is a sink, and the gateway decides when to talk.

That one fact drives every rule in the `homelab-iot` group. **When the gateway
goes silent the exporter keeps serving the last reading it received, forever.**
`ecowitt_temp`, `ecowitt_humidity` and `ecowitt_soilmoisture` do not go missing
and do not go to zero — they freeze at a plausible value. A dashboard built on
them looks healthy while showing yesterday's weather, and an alert built on them
cannot tell a calm day from a dead gateway.

The exporter's two freshness timestamps are the only honest staleness signal:

| Metric | Meaning |
|---|---|
| `ecowitt_last_report_timestamp_seconds` | Unix time of the most recent POST to `/report` from the gateway |
| `ecowitt_sensor_last_report_timestamp_seconds{sensor}` | Unix time that specific sensor last appeared in a push |

Both are seeded with the current time when the exporter starts, so a restart
does not immediately trip a staleness alert — the rule's `for:` window is the
grace period.

## The SLO

**User-visible path:** the weather and soil panels show current conditions.

**SLI** — fraction of time the newest gateway push was inside the freshness
threshold (`ECOWITT_GATEWAY_STALE_SECONDS`, default 900s):

```promql
avg_over_time(
  ((time() - ecowitt_last_report_timestamp_seconds) < bool 900)[30d:1m]
)
```

**Target: 99% over a rolling 30 days.** That is an error budget of about **7h
12m** of stale data per 30 days, which covers a battery change, a Wi-Fi outage
and a firmware update without eating the budget.

Burn rate over the last day, for the same window the alerts watch:

```promql
1 - avg_over_time(
  ((time() - ecowitt_last_report_timestamp_seconds) < bool 900)[1d:1m]
)
```

Both queries are asserted in `tests/alerts/ecowitt-iot.test.yaml` against a
window with a known outage, so the SLI is a measured number rather than an
intention: a gateway that goes silent 30 minutes into a one-hour window scores
**0.7333** (44 of 60 samples inside the threshold) and burns **0.2667** of the
budget.

This SLO gates nothing. Weather data is not on a release path, and an exhausted
budget here is a reason to change batteries, not to hold a deploy.

## Alerts

Every rule below is `severity: warning`. None of them is a paging matter: no
user-facing service depends on the weather. They render only when
`ECOWITT_ENABLED=true`.

### EcowittExporterDown

`absent(up{job="ecowitt-exporter", namespace="monitoring"} == 1)` for 10m.

Every other rule in the group reads a series this exporter produces, so while it
is down they all return no data and stay silent rather than firing. This alert is
the only one left standing, which is why it exists.

1. `kubectl -n monitoring get deploy,pod -l app.kubernetes.io/name=ecowitt-exporter`
2. `kubectl -n monitoring logs deploy/ecowitt-exporter`
3. If the pod is healthy, the scrape is the problem: check the ServiceMonitor is
   selected by Prometheus (`kubectl -n monitoring get servicemonitor ecowitt-exporter`)
   and that the target is up in the Prometheus UI under Status -> Targets.

### EcowittGatewayStale

`time() - ecowitt_last_report_timestamp_seconds > 900` for 10m.

This is the SLI threshold. The gateway has missed roughly 15 consecutive uploads
at the default 60s interval, so every panel is showing a stale reading.

1. Is the gateway on the network? Ping it, or look for it in the DHCP leases.
2. In the WSView/Ecowitt app, check **Customized** upload: protocol `Ecowitt`,
   server `ecowitt.<your domain>`, path `/report`, port 80, interval 60s.
   A changed domain or a re-flashed gateway silently resets this.
3. Power-cycle the gateway. It reconnects to Wi-Fi on boot and resumes pushing.
4. If the gateway is reachable but the exporter never sees a POST, the route is
   the suspect: `kubectl -n monitoring get httproute ecowitt-exporter` and check
   the internal Gateway resolves the hostname on the LAN.

### EcowittSensorStale

`time() - ecowitt_sensor_last_report_timestamp_seconds > 1800` for 15m.

The gateway is still pushing, but one sensor is no longer in the payload — it has
lost radio sync or its battery is flat. The threshold is deliberately higher than
the gateway's: a single 868/915MHz probe drops and re-syncs on its own, and a
15-minute gap is not worth a notification.

1. Note `{{ $labels.sensor }}`. `soilmoisture1` and `soilbatt1` are the same
   physical WH51 probe.
2. Check the battery first — a dying cell drops the radio before it stops the
   sensor outright. See `EcowittSensorBatteryVoltageLow` below.
3. Re-pair the sensor from the gateway console if a fresh cell does not bring it
   back, and check line-of-sight distance to the gateway.

### EcowittSensorMissing

`absent(ecowitt_sensor_last_report_timestamp_seconds{sensor="<name>"})` for 30m.

**This rule covers a blind spot in the one above, and it is worth understanding
because the gap is silent.** The exporter only creates a per-sensor freshness
series *after* that sensor first appears in a push. A probe that was already
offline when the exporter started therefore has no series at all, so
`time() - <missing>` returns no data and `EcowittSensorStale` can never fire for
it. The sensor is gone and the alert that is supposed to catch that is quiet.

The exporter can pre-seed these series from a `SENSORS_TO_TRACK` environment
variable, which would close the gap at the source — but **the upstream Helm chart
renders a fixed list of environment variables and has no `extraEnv`, so that
variable cannot be set through it** (verified against chart 2.2.2,
`templates/deployment.yaml`). Until that is fixed upstream, this `absent()` rule
is the cover.

It only exists for sensors named in `ECOWITT_EXPECTED_SENSORS`, because a rule
cannot assert that an unnamed thing is missing. **If you rely on a specific
probe, name it there** — otherwise its disappearance across an exporter restart
is invisible.

1. The named sensor has not reported once since the exporter started. Treat it as
   offline, not as a configuration error.
2. Work through the `EcowittSensorStale` steps: battery, then re-pair.
3. If the sensor was deliberately removed, drop it from
   `ECOWITT_EXPECTED_SENSORS` rather than silencing the alert.

### EcowittSensorBatteryLow

`ecowitt_batterystatus == 1` for 6h.

The sensor sets its own low-battery flag (0 = OK, 1 = low). It keeps reporting
for a while after this, so the alert is a lead indicator rather than an outage.
The 6h hold skips the cold-morning dips that clear as the day warms up.

Replace the cell. The flag clears on the next push.

### EcowittSensorBatteryLevelLow

`ecowitt_batterylevel <= 1` for 6h.

WH57 (lightning) and WH41 (PM2.5) report a 0-5 level instead of a flag. At 1 or
below the next cold night can take the sensor off the air. Same action: replace
the cell.

### EcowittSensorBatteryVoltageLow

`ecowitt_batteryvoltage{unit="volt"} < 1.2` for 6h.

Soil (WH51) and WS90 sensors report volts. The threshold is deliberately lower
than the upstream chart's own default of 1.5: an alkaline AA is 1.5V nominal and
reads about 1.6V fresh, so warning at 1.5 fires near the start of cell life and
trains you to ignore it. 1.2V leaves usable lead time before the radio drops.

Replace the cell. If you run rechargeable NiMH cells (1.2V nominal) this
threshold is wrong for you — lower `ECOWITT_BATTERY_VOLTAGE_MIN` to about 1.1
rather than turning the rule off.

### EcowittSoilMoistureLow

`ecowitt_soilmoisture{unit="percent"} < 20` for 1h.

The one rule in the group that reports a real reading rather than a device fault.
The threshold is a gardening choice, not a platform one: tune
`ECOWITT_SOIL_MOISTURE_MIN_PERCENT` to what you have planted rather than
silencing the alert. Water the bed, or move the probe if it is reading dry
because it has worked loose.

## Setting it up on a fork

Off by default: a fork has no weather gateway, and an exporter nothing pushes to
would sit at `EcowittGatewayStale` forever.

1. Set `ECOWITT_ENABLED=true` in your ConfigSet. That deploys the exporter, its
   ServiceMonitor, the HTTPRoute at `ECOWITT_HOSTNAME` (`ecowitt.<your domain>`)
   and the `homelab-iot` rule group.
2. Point the gateway at it. In the WSView Plus app: **Device -> Customized**,
   protocol `Ecowitt`, server `ecowitt.<your domain>`, path `/report`, port 80,
   upload interval 60s.
3. Name the probes you depend on in `ECOWITT_EXPECTED_SENSORS`, for example
   `soilmoisture1,soilbatt1`.
4. Confirm data is arriving:

   ```sh
   kubectl -n monitoring port-forward svc/ecowitt-exporter 8088:8088
   curl -s localhost:8088/metrics | grep ecowitt_last_report_timestamp_seconds
   ```

   The value should be within one upload interval of `date +%s`.

Units default to metric (`c`, `hpa`, `kmh`, `mm`) and are set in
`configuration/templates/helm-addons.tmpl`.

## Why these rules are not the chart's own

The upstream chart ships a `prometheusRules` block with battery and weather
alerts. It stays disabled, and the rules above are declared in this repository's
`additionalPrometheusRulesMap` instead.

A remote chart's `PrometheusRule` is rendered by ArgoCD at sync time, where
neither the `runbooks/coverage` check nor `task test:alerts` can read it. Alerts
declared there would ship with no runbook and no unit test, and no gate in this
repository would notice. Declaring them here keeps every alert inside the two
gates that enforce the standard.

## Testing and the bypass path

`task test:alerts` unit-tests all eight rules with promtool against the
expressions the chart actually renders (`tests/alerts/ecowitt-iot.test.yaml`).
Each test brackets its threshold — one assertion below it that must stay silent,
one above it that must fire — because a rule that fires on everything and a rule
that fires on nothing both pass a one-sided test.

The rule group renders only when `ECOWITT_ENABLED=true`, so
`tests/alerts/values-rules-on.yaml` turns the group on for the test render
without any environment deploying the exporter.

**To suppress one of these alerts in a genuine emergency**, add a time-bounded
silence in Alertmanager and record the reason and expiry on the tracking issue.
Do not delete the rule and do not widen a threshold to make a dashboard green;
change the ConfigSet value if the threshold is genuinely wrong for your hardware,
which is why every one of them is a ConfigSet key.
