# Minimal Dovecot for mail-ai integration tests.
# We do NOT use this in production; this is only for the dev stack and CI.
FROM dovecot/dovecot:2.3-debian

COPY users /etc/dovecot/users
COPY local.conf /etc/dovecot/conf.d/99-mailai.conf
RUN mkdir -p /srv/mail && chown -R dovecot:dovecot /srv/mail
