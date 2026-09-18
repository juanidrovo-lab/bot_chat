/**
 * Lo poco que el panel necesita del navegador.
 *
 * Solo el simulador: cada respuesta se añade al final del chat, y sin bajar el desplazamiento
 * el mensaje nuevo queda fuera de la vista — se pulsa un botón y parece que no pasó nada.
 *
 * Va en un fichero servido por el propio proceso y no en línea porque la
 * `Content-Security-Policy` del panel es `script-src 'self'`: un `<script>` suelto en la
 * página no se ejecutaría, y esa política no se relaja por una comodidad.
 */
function alFinal() {
  const chat = document.getElementById('conversacion');
  if (chat === null) return;
  /**
   * En el fotograma siguiente, no ahora: cuando HTMX avisa, el nodo está en el DOM pero el
   * navegador todavía no lo ha medido, y una tarjeta de imagen alta se quedaba a medias
   * debajo del borde. Con `scrollHeight` ya calculado, baja hasta el final de verdad.
   */
  requestAnimationFrame(() => {
    chat.scrollTop = chat.scrollHeight;
  });
}

// Al cargar y después de cada respuesta de HTMX, incluida la de «empezar de nuevo», que
// reemplaza el bloque entero.
document.addEventListener('DOMContentLoaded', alFinal);
document.body.addEventListener('htmx:afterSwap', alFinal);
document.body.addEventListener('htmx:afterSettle', alFinal);
