# TempMail — correo temporal que sí recibe

Servicio de correo temporal **real**: genera una dirección en
`temp.robindark.co`, recibe correos de verdad y extrae el código de
confirmación para mostrarlo destacado.

No usa ningún servicio de envío/recepción de correo, ni claves API, ni
una API externa de correos temporales. La recepción ocurre **solo** a
través del webhook `POST /api/incoming-email`, llamado por un
Cloudflare Worker (Email Routing) que reenvía cada mensaje entrante
como JSON.

Es un servicio **público y anónimo**: cualquiera que entre a la página
puede generar su dirección y usar su buzón sin registro ni inicio de
sesión. No hay cuentas ni login.

## Cómo funciona

1. El usuario genera una dirección, por ejemplo `k9x2m7q4z8@temp.robindark.co`.
2. Esa dirección vive **30 minutos** (extensible una sola vez por 30 min más) y luego se borra con todos sus correos.
3. Cuando alguien envía un correo a esa dirección, Cloudflare Email Routing lo entrega al Worker, y el Worker hace `POST /api/incoming-email` con el mensaje ya parseado.
4. La app guarda el correo bajo esa dirección y extrae el código de confirmación (4-8 dígitos, también `123 456` o `123-456`).
5. La bandeja del usuario se actualiza sola cada 5 segundos.

**Sin generación automática:** las direcciones solo se crean cuando el
usuario toca el botón de generar. Nada crea ni rota direcciones por sí
solo: una dirección se mantiene igual hasta que expire (30 minutos), el
usuario la elimine o genere otra manualmente. El único temporizador del
servidor borra las direcciones expiradas; nunca crea una.

## Ejecutar

```bash
npm install
node server.js
```

- `PORT` (por defecto `3000`).
- `TEMP_MAIL_DOMAIN` (por defecto `temp.robindark.co`).

## Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/health` | `{ok:true, app:"temp-mail"}` |
| POST | `/api/inbox` | Crea una dirección. Devuelve `{address, expiresAt}`. Límite: 20 por IP por hora. |
| GET | `/api/inbox/:address` | Lista los correos de la dirección, del más reciente al más antiguo. Cada correo: `{id, from, subject, snippet, receivedAt, hasCode, code}`. |
| GET | `/api/inbox/:address/:id` | Correo completo: `{from, subject, text, html, receivedAt, code}`. |
| DELETE | `/api/inbox/:address` | Elimina la dirección y sus correos. |
| POST | `/api/inbox/:address/extend` | Extiende la expiración 30 min (una sola vez por dirección). |
| POST | `/api/incoming-email` | Webhook de correo entrante (lo llama el Worker). Límite global: 200/min. |

La interfaz web está en `/` (archivos estáticos en `public/`).

## Cómo conectar el Cloudflare Worker

1. En Cloudflare, crea un subdominio `temp.robindark.co` y activa **Email Routing** para ese dominio (o para `robindark.co` con una regla que capture `*@temp.robindark.co`).
2. Crea un **Email Worker** con el código de abajo y asígnalo como destino de la ruta. El Worker parsea el mensaje y lo reenvía a esta app.

```js
// Cloudflare Email Worker — reenvía cada correo a TempMail.
// Requiere la librería `postal-mime` en el Worker para parsear el MIME.
// Variable de entorno del Worker: TEMP_MAIL_URL = https://<tu-app>.up.railway.app

import PostalMime from 'postal-mime';

export default {
  async email(message, env, ctx) {
    const raw = await new Response(message.raw).arrayBuffer();
    const parsed = await PostalMime.parse(raw);

    const payload = {
      to: message.to,                       // ej. k9x2m7q4z8@temp.robindark.co
      from: message.from,
      subject: parsed.subject || '',
      text: parsed.text || '',
      html: parsed.html || '',
      receivedAt: new Date().toISOString(),
    };

    ctx.waitUntil(fetch(env.TEMP_MAIL_URL + '/api/incoming-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }));
  },
};
```

Notas:

- El Worker debe enviar `to` con la dirección completa; la app compara solo la parte local (antes de `@`), sin distinguir mayúsculas.
- Si la dirección no existe o expiró, la app responde `200 {ok:true, ignored:true}` y el correo se descarta.
- El Worker no necesita ninguna clave: el webhook es público por diseño (cualquiera puede enviarle un correo a una dirección temporal, igual que a cualquier buzón). Si quieres restringirlo, pon un secreto compartido en una cabecera y valídalo en `server.js`.

## Almacenamiento

En memoria (`Map`). No hay base de datos: al reiniciar el proceso se pierde todo, y cada dirección se borra automáticamente a los 30 minutos. Es lo correcto para un correo temporal.

## Tests

```bash
npm test
```

Verifica: health, creación de direcciones y su formato, límite de 20/hora, webhook que guarda el correo bajo la dirección correcta, extracción de códigos (`482913`, `123 456`, `123-456`), correo sin código, webhook a dirección desconocida/expirada (ignorado con 200), extender una sola vez, expiración y borrado.
