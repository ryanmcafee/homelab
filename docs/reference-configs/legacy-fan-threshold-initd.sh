#!/bin/bash
### BEGIN INIT INFO
# Provides:          set_fan_threshold
# Required-Start:    $network $remote_fs
# Required-Stop:
# Default-Start:     2 3 4 5
# Default-Stop:
# Short-Description: Set IPMI fan thresholds for quiet Noctua fans
### END INIT INFO

IPMI_HOST="172.16.10.36"
IPMI_USER="ADMIN"
IPMI_PASS="PSPUHISRDM"

FANS="FAN1 FAN2 FAN3 FAN4 FANA"
THRESH_LNR=100   # Lower Non-Recoverable
THRESH_LC=150    # Lower Critical
THRESH_LNC=200   # Lower Non-Critical

case "$1" in
  start)
    for fan in $FANS; do
      ipmitool -I lan -H "$IPMI_HOST" -U "$IPMI_USER" -P "$IPMI_PASS" \
        sensor thresh "$fan" lower $THRESH_LNR $THRESH_LC $THRESH_LNC
    done
    ;;
  *)
    echo "Usage: $0 start"
    exit 1
    ;;
esac

exit 0
