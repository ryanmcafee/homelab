# Bug Log

Track bugs encountered during development along with their solutions. This helps avoid solving the same problems twice and preserves institutional knowledge.

## Format

Each entry should include:
- Date (YYYY-MM-DD)
- Brief description of the bug/issue
- Solution or fix applied
- Any prevention notes (optional)

## Example Entries

### 2025-01-15 - Docker Container Fails to Start on Cloud Run
- **Issue**: Container built locally wouldn't start on Cloud Run with "exec format error"
- **Root Cause**: Built on ARM64 Mac but Cloud Run expects AMD64
- **Solution**: Added `--platform linux/amd64` to docker build command
- **Prevention**: Updated Makefile to always specify platform for production builds

### 2025-01-20 - Cloud Scheduler Jobs Failing with 404
- **Issue**: Scheduled jobs returning 404 errors despite correct endpoint
- **Root Cause**: Cloud Scheduler was using HTTP instead of HTTPS for Cloud Run URL
- **Solution**: Updated all scheduler job URLs to use HTTPS protocol
- **Prevention**: Added URL validation in Pulumi code to enforce HTTPS

### 2025-01-22 - Database Connection Pool Exhaustion
- **Issue**: API returning 500 errors under moderate load
- **Root Cause**: Default connection pool size (5) too small for concurrent requests
- **Solution**: Increased pool_size to 20, max_overflow to 30 in SQLAlchemy config
- **Prevention**: Added connection pool monitoring to Prometheus metrics

## Tips

- Keep descriptions under 2-3 lines
- Focus on the lesson learned, not just the fix
- Include enough context for future reference
- Clean out very old entries periodically (6+ months)
