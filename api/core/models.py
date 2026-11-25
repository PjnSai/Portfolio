import uuid

from django.db import models
from django.utils import timezone


class Base(models.Model):
    """Every table gets a random UUID key, never a sequential integer."""

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)

    class Meta:
        abstract = True

    def __str__(self):
        return f"{self._meta.db_table}:{self.id}"


class Timestamped(Base):
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        abstract = True


class SiteSettings(Timestamped):
    draft = models.JSONField(default=dict)
    published = models.JSONField(default=dict)
    published_at = models.DateTimeField(null=True, blank=True)
    # Set when the last cache purge failed, cleared by the next one that works.
    purge_failed_at = models.DateTimeField(null=True, blank=True)
    # The last call to the Pages deploy hook, its result, and whether a change
    # made since is waiting for the next call (see core.deploy).
    deploy_called_at = models.DateTimeField(null=True, blank=True)
    deploy_result = models.CharField(max_length=10, blank=True, default="")
    deploy_pending = models.BooleanField(default=False)
    # How long contact messages are kept (core.retention). Private: these are not
    # part of the draft or published copies, so they never reach the public site.
    retention_spam_days = models.PositiveIntegerField(default=30)
    retention_message_days = models.PositiveIntegerField(default=365)
    # Contact form limits (core.limits). Private, like the periods above. Null
    # means the default in settings.py applies.
    contact_human_daily_cap = models.PositiveSmallIntegerField(null=True, blank=True)
    contact_spam_daily_cap = models.PositiveSmallIntegerField(null=True, blank=True)
    contact_per_address_per_hour = models.PositiveSmallIntegerField(
        null=True, blank=True
    )
    contact_per_email_per_day = models.PositiveSmallIntegerField(null=True, blank=True)
    contact_min_seconds = models.PositiveSmallIntegerField(null=True, blank=True)
    contact_max_links = models.PositiveSmallIntegerField(null=True, blank=True)
    contact_spam_threshold = models.PositiveSmallIntegerField(null=True, blank=True)
    blocklist_months = models.PositiveSmallIntegerField(null=True, blank=True)

    class Meta:
        db_table = "site_settings"


class Palette(Timestamped):
    """A set of colour tokens for light and dark. Presets come from a migration
    and cannot be changed; the owner duplicates one to make a custom palette."""

    class Kind(models.TextChoices):
        PRESET = "preset"
        CUSTOM = "custom"

    name = models.CharField(max_length=60)
    kind = models.CharField(max_length=10, choices=Kind.choices, default=Kind.CUSTOM)
    # {"bg": "#RRGGBB", ...}, one entry per slot in core.theme.SLOTS.
    light = models.JSONField(default=dict)
    dark = models.JSONField(default=dict)
    trashed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "palettes"
        # Presets first ("preset" sorts after "custom", so descending).
        ordering = ["-kind", "created_at", "name"]


class Section(Timestamped):
    type = models.CharField(max_length=40)
    position = models.PositiveIntegerField(default=0)
    visible = models.BooleanField(default=True)
    draft = models.JSONField(default=dict)
    published = models.JSONField(default=dict)
    published_at = models.DateTimeField(null=True, blank=True)
    trashed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "sections"
        ordering = ["position"]


class SectionItem(Timestamped):
    """One entry in a section: a project, a job, a skill group, a link."""

    section = models.ForeignKey(Section, on_delete=models.CASCADE, related_name="items")
    position = models.PositiveIntegerField(default=0)
    visible = models.BooleanField(default=True)
    draft = models.JSONField(default=dict)
    published = models.JSONField(default=dict)
    trashed_at = models.DateTimeField(null=True, blank=True)
    # A project's address under /projects/, set when it is first published and
    # kept after (core.slugs). Null for other items and unpublished projects.
    slug = models.CharField(max_length=80, null=True, blank=True, unique=True)

    class Meta:
        db_table = "section_items"
        ordering = ["position"]


class Media(Base):
    storage_key = models.CharField(max_length=255, unique=True)
    content_type = models.CharField(max_length=100)
    size = models.PositiveBigIntegerField()
    sha256 = models.CharField(max_length=64)
    width = models.PositiveIntegerField(null=True, blank=True)
    height = models.PositiveIntegerField(null=True, blank=True)
    alt = models.CharField(max_length=300, blank=True)
    # The stored sizes: [{"name", "width", "height", "size"}], smallest first.
    variants = models.JSONField(default=list)
    created_at = models.DateTimeField(default=timezone.now)
    trashed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "media"


class CvFile(Base):
    storage_key = models.CharField(max_length=255, unique=True)
    sha256 = models.CharField(max_length=64)
    size = models.PositiveBigIntegerField()
    is_current = models.BooleanField(default=False)
    created_at = models.DateTimeField(default=timezone.now)
    trashed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "cv_files"


class Contact(Timestamped):
    """A sender the owner chose to keep a record of (core.contacts). One per
    email, found by the same keyed hash as the messages. Deleting one never
    deletes a message: its messages are unlinked."""

    name = models.CharField(max_length=100)
    email = models.EmailField(max_length=254)
    email_hash = models.CharField(max_length=64, unique=True)
    organisation = models.CharField(max_length=100, blank=True, default="")
    tags = models.JSONField(default=list)
    notes = models.TextField(blank=True, default="")
    follow_up = models.DateField(null=True, blank=True)

    class Meta:
        db_table = "contacts"
        ordering = ["name", "id"]

    def save(self, *args, **kwargs):
        if not self.email_hash:
            from core.contact import email_hash

            self.email_hash = email_hash(self.email)
        super().save(*args, **kwargs)


class ContactMessage(Base):
    """A message from the public form. The sender's address is kept only as a
    keyed hash (core.contact.address_hash); the cleanup job removes rows after
    expires_at unless the owner marked them kept, has written notes on them or
    linked them to a contact (core.retention)."""

    class Status(models.TextChoices):
        NEW = "new"
        READ = "read"
        REPLIED = "replied"
        ARCHIVED = "archived"
        SPAM = "spam"

    class Reason(models.TextChoices):
        HIRING = "hiring"
        PROJECT = "project"
        OTHER = "other"

    name = models.CharField(max_length=100)
    email = models.EmailField()
    body = models.TextField()
    reason = models.CharField(
        max_length=10, choices=Reason.choices, blank=True, default=""
    )
    # 0 to 100: how many of the bot checks the message tripped, and how hard
    # (core.contact.spam_score). A score of 100 or more is quarantined.
    spam_score = models.PositiveSmallIntegerField(default=0)
    status = models.CharField(max_length=10, choices=Status.choices, default="new")
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    read_at = models.DateTimeField(null=True, blank=True)
    kept = models.BooleanField(default=False)
    expires_at = models.DateTimeField(db_index=True)
    # When it became spam: on arrival, or when the owner marked it. The spam
    # retention period runs from here. Cleared by "Not spam".
    spam_at = models.DateTimeField(null=True, blank=True)
    ip_hash = models.CharField(max_length=64, blank=True, default="")
    # The keyed hash of the email (core.contact.email_hash), so every message
    # from one sender can be found for "delete everything about this email".
    email_hash = models.CharField(
        max_length=64, blank=True, default="", db_default="", db_index=True
    )
    # A message linked to a contact is never removed by the daily job.
    contact = models.ForeignKey(
        Contact,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="messages",
    )

    class Meta:
        db_table = "contact_messages"
        ordering = ["-created_at"]

    def save(self, *args, **kwargs):
        if not self.email_hash:
            from core.contact import email_hash

            self.email_hash = email_hash(self.email)
        super().save(*args, **kwargs)


class ContactNote(Base):
    """The owner's timeline on a message. Append-only: a note is never edited,
    and goes only when its message does (the app role has no UPDATE on it)."""

    class Kind(models.TextChoices):
        NOTE = "note"
        RESPONDED = "responded_with_details"

    message = models.ForeignKey(
        ContactMessage, on_delete=models.CASCADE, related_name="notes"
    )
    text = models.TextField()
    kind = models.CharField(max_length=30, choices=Kind.choices, default="note")
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = "contact_notes"
        ordering = ["created_at", "id"]

    def save(self, *args, **kwargs):
        if not self._state.adding:
            raise RuntimeError("A note cannot be edited.")
        super().save(*args, **kwargs)

    def delete(self, *args, **kwargs):
        raise RuntimeError("A note goes only with its message.")


class BlockedSender(Base):
    """A sender the owner blocked. Only the keyed hash of the email is kept
    (core.contact.email_hash), never the address; it stops blocking at
    expires_at and the daily job removes it then (core.blocklist)."""

    email_hash = models.CharField(max_length=64, unique=True)
    note = models.CharField(max_length=200, blank=True, default="")
    created_at = models.DateTimeField(default=timezone.now)
    expires_at = models.DateTimeField(db_index=True)

    class Meta:
        db_table = "blocked_senders"
        ordering = ["-created_at", "id"]


class Revision(Base):
    entity = models.CharField(max_length=40)
    entity_id = models.UUIDField()
    version = models.PositiveIntegerField()
    data = models.JSONField()
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        db_table = "revisions"
        constraints = [
            models.UniqueConstraint(
                fields=["entity", "entity_id", "version"], name="revisions_unique"
            )
        ]


class AuditLog(Base):
    """Append-only. Write through core.audit.record, never directly."""

    seq = models.PositiveBigIntegerField(unique=True)
    created_at = models.DateTimeField()
    event = models.CharField(max_length=60)
    actor = models.CharField(max_length=40)
    detail = models.JSONField(default=dict)
    prev_hash = models.CharField(max_length=64, unique=True)
    hash = models.CharField(max_length=64, unique=True)

    class Meta:
        db_table = "audit_log"
        ordering = ["seq"]


class Owner(Base):
    """The one admin account. The migration creates the only row; the database
    refuses a second one and the app role cannot insert or delete it."""

    singleton = models.BooleanField(default=True, unique=True, editable=False)
    created_at = models.DateTimeField(default=timezone.now)
    bootstrapped_at = models.DateTimeField(null=True, blank=True)
    recovery_key_hash = models.CharField(max_length=128, blank=True, default="")

    class Meta:
        db_table = "admin_owner"
        constraints = [
            models.CheckConstraint(
                condition=models.Q(singleton=True), name="admin_owner_single_row"
            )
        ]


class AdminCredential(Base):
    """A passkey. Public key only; there is no password anywhere."""

    credential_id = models.BinaryField(max_length=1023, unique=True)
    public_key = models.BinaryField()
    sign_count = models.PositiveBigIntegerField(default=0)
    name = models.CharField(max_length=100)
    created_at = models.DateTimeField(default=timezone.now)
    last_used_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "admin_credentials"


class Session(Base):
    """Only the SHA-256 of the session token is stored."""

    owner = models.ForeignKey(Owner, on_delete=models.PROTECT, related_name="+")
    token_hash = models.CharField(max_length=64, unique=True)
    created_at = models.DateTimeField(default=timezone.now)
    authenticated_at = models.DateTimeField(default=timezone.now)
    last_seen_at = models.DateTimeField(default=timezone.now)
    elevated_until = models.DateTimeField(null=True, blank=True)
    revoked_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "sessions"


class RateLimitBlock(Base):
    """A cool-down. The key is a keyed hash, never a raw IP address."""

    key_hash = models.CharField(max_length=64, unique=True)
    scope = models.CharField(max_length=40)
    created_at = models.DateTimeField(default=timezone.now)
    expires_at = models.DateTimeField(db_index=True)

    class Meta:
        db_table = "rate_limit_blocks"


class PendingAction(Base):
    """A vital action waiting out its delay before it may be executed."""

    class Status(models.TextChoices):
        PENDING = "pending"
        EXECUTED = "executed"
        CANCELLED = "cancelled"
        EXPIRED = "expired"

    kind = models.CharField(max_length=40)
    payload = models.JSONField(default=dict)
    status = models.CharField(
        max_length=20, choices=Status.choices, default=Status.PENDING
    )
    requested_at = models.DateTimeField(default=timezone.now)
    execute_after = models.DateTimeField()
    expires_at = models.DateTimeField()
    resolved_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "pending_actions"
        ordering = ["requested_at"]
