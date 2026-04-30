# Local Development

MailAI can run standalone, but integrated testing should use hof-os shared services so auth, Postgres, Redis, and object-storage assumptions match the cell runtime.

```sh
cd ~/repos/hof-os
make dev DEV_SUBAPP=mailai
```

In a second terminal, use the env printed by hof-os:

```sh
cd ~/repos/mail-ai
export HOF_ENV=dev
export HOF_SUBAPP_JWT_SECRET=<value from ~/repos/hof-os/.env>
export DATABASE_URL=postgresql://hofos:hofos@localhost:5432/mailai
export REDIS_URL=redis://localhost:6379/0
export HOF_DATA_APP_PUBLIC_URL=http://app.localhost:3000
make dev
```

For Docker-sidecar testing from hof-os instead, run `make dev SUBAPPS=mailai`.
