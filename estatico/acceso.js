/**
 * Las dos llamadas a WebAuthn, que solo puede hacer el navegador.
 *
 * Todo lo demás —el reto, su caducidad, la verificación de la firma, la sesión— vive en el
 * servidor. Aquí no se decide nada: se traduce entre el JSON que manda el servidor y las
 * estructuras binarias que pide `navigator.credentials`, que es literalmente lo único que
 * no se puede hacer del otro lado.
 */
const base = document.currentScript?.dataset.base ?? location.pathname.replace(/\/$/, '');

const deB64Url = (texto) =>
  Uint8Array.from(atob(texto.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

const aB64Url = (buffer) =>
  btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

async function pedir(ruta, cuerpo) {
  const respuesta = await fetch(`${base}${ruta}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cuerpo ?? {}),
  });
  if (!respuesta.ok) throw new Error(`${respuesta.status}`);
  return respuesta.json();
}

function avisar(texto) {
  const caja = document.getElementById('aviso');
  if (caja !== null) caja.textContent = texto;
}

async function entrar() {
  try {
    const { opciones, reto } = await pedir('/acceso/inicio');

    opciones.challenge = deB64Url(opciones.challenge);
    for (const c of opciones.allowCredentials ?? []) c.id = deB64Url(c.id);

    const credencial = await navigator.credentials.get({ publicKey: opciones });
    if (credencial === null) return;

    await pedir('/acceso/fin', {
      reto,
      credencialId: credencial.id,
      respuesta: {
        id: credencial.id,
        rawId: aB64Url(credencial.rawId),
        type: credencial.type,
        response: {
          clientDataJSON: aB64Url(credencial.response.clientDataJSON),
          authenticatorData: aB64Url(credencial.response.authenticatorData),
          signature: aB64Url(credencial.response.signature),
          userHandle:
            credencial.response.userHandle === null
              ? null
              : aB64Url(credencial.response.userHandle),
        },
        clientExtensionResults: credencial.getClientExtensionResults(),
      },
    });

    location.assign(base);
  } catch (error) {
    // Ni el motivo ni el detalle: el mensaje de un fallo de acceso es lo que convierte un
    // formulario en un comprobador de quién trabaja en el estudio.
    if (error instanceof DOMException && error.name === 'NotAllowedError') return;
    avisar('No se pudo entrar. Inténtelo otra vez.');
  }
}

document.getElementById('entrar')?.addEventListener('click', () => void entrar());
