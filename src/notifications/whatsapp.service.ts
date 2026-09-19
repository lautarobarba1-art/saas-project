import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Nombre e idioma del template aprobado en Meta para confirmar una
// reserva. Un mensaje que inicia el negocio (no una respuesta dentro
// de la ventana de 24hs) tiene que salir de un template pre-aprobado
// — no se puede mandar texto libre acá. Ver WABA en Meta Business
// Suite si hay que revisar/editar el contenido aprobado.
const TEMPLATE_NAME = 'canchaya_reserva_confirmada';
const TEMPLATE_LANGUAGE = 'es_AR';

@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  constructor(private readonly config: ConfigService) {}

  // Nunca lanza: un fallo de notificación no puede tirar abajo la
  // confirmación del pago/reserva, que ya sucedió de verdad. El
  // llamador no necesita (ni debería) esperar a que esto termine para
  // seguir su propio flujo.
  async sendBookingConfirmation(params: {
    phone: string;
    clientName: string;
    tenantName: string;
    resourceName: string;
    whenLabel: string;
  }): Promise<void> {
    const phoneNumberId = this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID');
    const token = this.config.get<string>('WHATSAPP_ACCESS_TOKEN');
    if (!phoneNumberId || !token) {
      this.logger.warn(
        'WhatsApp no configurado (faltan WHATSAPP_PHONE_NUMBER_ID/WHATSAPP_ACCESS_TOKEN) — se omite la notificación',
      );
      return;
    }

    const to = params.phone.replace(/[^0-9]/g, '');
    if (!to) {
      this.logger.warn('Teléfono de la reserva vacío tras normalizar — se omite la notificación');
      return;
    }

    try {
      const res = await fetch(
        `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to,
            type: 'template',
            template: {
              name: TEMPLATE_NAME,
              language: { code: TEMPLATE_LANGUAGE },
              components: [
                {
                  type: 'body',
                  parameters: [
                    { type: 'text', text: params.clientName },
                    { type: 'text', text: params.tenantName },
                    { type: 'text', text: params.resourceName },
                    { type: 'text', text: params.whenLabel },
                  ],
                },
              ],
            },
          }),
        },
      );

      if (!res.ok) {
        const body = await res.text();
        this.logger.error(`No se pudo enviar la notificación de WhatsApp: ${res.status} ${body}`);
      }
    } catch (err) {
      this.logger.error(
        `Error de red enviando la notificación de WhatsApp: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // Texto libre, no un template: solo válido como respuesta dentro de
  // la ventana de 24hs desde el último mensaje del cliente (política de
  // Meta para mensajes iniciados por el negocio vs. respuestas). El bot
  // solo la usa para responder a alguien que le acaba de escribir, nunca
  // para iniciar una conversación — eso sigue yendo por template.
  async sendFreeText(phone: string, text: string): Promise<void> {
    const phoneNumberId = this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID');
    const token = this.config.get<string>('WHATSAPP_ACCESS_TOKEN');
    if (!phoneNumberId || !token) {
      this.logger.warn(
        'WhatsApp no configurado (faltan WHATSAPP_PHONE_NUMBER_ID/WHATSAPP_ACCESS_TOKEN) — se omite la respuesta',
      );
      return;
    }

    const to = phone.replace(/[^0-9]/g, '');
    if (!to) return;

    try {
      const res = await fetch(
        `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to,
            type: 'text',
            text: { body: text },
          }),
        },
      );

      if (!res.ok) {
        const body = await res.text();
        this.logger.error(`No se pudo responder por WhatsApp: ${res.status} ${body}`);
      }
    } catch (err) {
      this.logger.error(
        `Error de red respondiendo por WhatsApp: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
