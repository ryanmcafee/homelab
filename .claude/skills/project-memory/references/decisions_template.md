# Architectural Decision Records (ADRs)

Document significant technical decisions made during the project. This helps maintain consistency and provides context for future changes.

## Format

Each decision should include:
- Date and ADR number
- Context (why the decision was needed)
- Decision (what was chosen)
- Alternatives considered
- Consequences (trade-offs, implications)

## Example Entries

### ADR-001: Use Workload Identity Federation for GitHub Actions (2025-01-10)

**Context:**
- Need to authenticate GitHub Actions to GCP for deployments
- Traditional approach uses long-lived service account keys
- Keys require rotation and pose security risks if leaked

**Decision:**
- Use Workload Identity Federation (WIF) instead of service account keys
- Configure GitHub as an external identity provider in GCP
- Map GitHub repository to GCP service account via attribute conditions

**Alternatives Considered:**
- Service Account Keys -> Rejected due to security risks and rotation overhead
- GitHub App authentication -> More complex, less GCP-native

**Consequences:**
- No secrets to manage or rotate
- More complex initial setup (WIF pool, provider, IAM bindings)
- Better security posture (short-lived tokens, no persistent credentials)
- Requires GCP project-level configuration

### ADR-002: Use Alembic for Database Migrations (2025-01-12)

**Context:**
- Need version-controlled database schema changes
- Team familiar with SQLAlchemy ORM
- Want to track migrations in git alongside code

**Decision:**
- Use Alembic for all database migrations
- Store migrations in `alembic/versions/` directory
- Run migrations as part of deployment pipeline

**Alternatives Considered:**
- Raw SQL scripts -> Harder to track, no rollback support
- Django migrations -> Would require Django framework
- Flyway -> Java-based, less Python-native

**Consequences:**
- Tight integration with SQLAlchemy models
- Auto-generation of migrations from model changes
- Requires learning Alembic CLI and configuration
- Team must follow migration workflow (never edit deployed migrations)

### ADR-003: AlloyDB Instead of Cloud SQL (2025-01-15)

**Context:**
- Application requires PostgreSQL database
- Expecting moderate to high query load
- Need managed service in GCP

**Decision:**
- Use AlloyDB instead of Cloud SQL for PostgreSQL
- Deploy in same region as Cloud Run services
- Use AlloyDB Auth Proxy for local development

**Alternatives Considered:**
- Cloud SQL PostgreSQL -> Lower performance, but simpler and cheaper
- Self-managed PostgreSQL on GKE -> More control, but significant ops overhead
- CockroachDB -> Overkill for current scale, higher cost

**Consequences:**
- Higher performance (4x faster queries claimed)
- Higher cost (~$200/month minimum vs ~$50 for Cloud SQL)
- Requires AlloyDB Auth Proxy for connections
- Better scaling options for future growth

## Tips

- Number decisions sequentially (ADR-001, ADR-002, etc.)
- Include date for temporal context
- Be honest about trade-offs (both positive and negative consequences)
- Keep alternatives brief - just enough to show what was considered
- Don't include implementation details - focus on the "why" not the "how"
