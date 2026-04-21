# Minimal Dovecot for mail-ai integration tests.
# Only used in the dev stack / CI, never production.
#
# Upstream removed the `2.3-debian` tag during the 2.4 migration and
# the new images run rootless on non-standard ports. We pin to
# `latest-root` so the container keeps the classic 143/993 layout
# our tests expect. Note: dovecot 2.4 changed config syntax — when
# we re-enable Dovecot in the integration suite we will need to
# regenerate `local.conf`.
FROM dovecot/dovecot:latest-root

COPY users /etc/dovecot/users
COPY local.conf /etc/dovecot/conf.d/99-mailai.conf
RUN mkdir -p /srv/mail && chown -R dovecot:dovecot /srv/mail
