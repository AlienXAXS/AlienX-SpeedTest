FROM nginx:1.27-alpine

# Install gettext for envsubst
RUN apk add --no-cache gettext

# Copy static assets
COPY style.css app.js config.js.tmpl /usr/share/nginx/html/
COPY index.html /usr/share/nginx/html/index.html.tmpl

# Nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Entrypoint that injects env vars into config.js
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 80

ENTRYPOINT ["/entrypoint.sh"]
