Read AGENTS.md and apply the rules to all subagents.
When implementing plans, always analyze the plan first and look for opportunies to use sub agents.
Before implementing a plan, ensure that 'bd' is used for task tracking to support saving progress and context for long running tasks.

## Helm Chart Version Sources

When updating helm chart versions, check the Chart.yaml in these repositories:

| Chart | Source |
|-------|--------|
| Plex | https://github.com/plexinc/pms-docker/blob/master/charts/plex-media-server/Chart.yaml |
| TrueCharts (all) | https://github.com/trueforge-org/truecharts/tree/master/charts/stable/{chart-name}/Chart.yaml |

TrueCharts direct links:
- Sonarr: https://raw.githubusercontent.com/trueforge-org/truecharts/master/charts/stable/sonarr/Chart.yaml
- Radarr: https://raw.githubusercontent.com/trueforge-org/truecharts/master/charts/stable/radarr/Chart.yaml
- Prowlarr: https://raw.githubusercontent.com/trueforge-org/truecharts/master/charts/stable/prowlarr/Chart.yaml
- Home Assistant: https://raw.githubusercontent.com/trueforge-org/truecharts/master/charts/stable/home-assistant/Chart.yaml
- Mosquitto: https://raw.githubusercontent.com/trueforge-org/truecharts/master/charts/stable/mosquitto/Chart.yaml
