import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import Anthropic from '@anthropic-ai/sdk';
import { TenantContextService } from '../database/tenant-context.service';
import { TenantsService } from '../tenants/tenants.service';
import { WhatsAppService } from '../notifications/whatsapp.service';
import { ConversationStateService } from './conversation-state.service';

const MODEL = 'claude-haiku-4-5-20251001';

interface InboundMessage {
  from: string;
  type: string;
  text?: { body: string };
}

// Lógica pura, exportada para poder testearla sin levantar el módulo
// completo (sin DB, sin Meta, sin Anthropic) — mismo criterio que
// mapOrderStatus/encodeReference en payments.service.ts.
export function verifyWebhookSignature(
  rawBody: Buffer | undefined,
  signature: string | undefined,
  secret: string | undefined,
): boolean {
  if (!secret || !signature || !rawBody) return false;

  const expected =
    'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const received = Buffer.from(signature);
  const calculated = Buffer.from(expected);
  if (received.length !== calculated.length) return false;
  return timingSafeEqual(received, calculated);
}

// Candidatos de slug de club a partir de un mensaje entrante: primero
// el tag "(ref:<slug>)" que precarga el link "Consultanos por
// WhatsApp" (dato exacto), y como respaldo el mensaje completo
// slugificado (para alguien que escribe el nombre del club directo,
// ej. "demo"). Devueltos en orden de prioridad — el llamador prueba
// cada uno contra la base hasta encontrar un club real.
export function extractSlugCandidates(text: string): string[] {
  const candidates: string[] = [];

  const refMatch = text.match(/ref:([a-z0-9-]+)/i);
  if (refMatch) candidates.push(refMatch[1].toLowerCase());

  const guessSlug = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (guessSlug && !candidates.includes(guessSlug)) candidates.push(guessSlug);

  return candidates;
}

@Injectable()
export class WhatsappBotService {
  private readonly logger = new Logger(WhatsappBotService.name);
  private anthropic: Anthropic | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly tenantContext: TenantContextService,
    private readonly tenants: TenantsService,
    private readonly whatsapp: WhatsAppService,
    private readonly conversations: ConversationStateService,
  ) {}

  // Nunca lanza — ver el comentario en el controller. Cualquier fallo
  // queda logueado, nunca tira abajo la respuesta 200 que espera Meta.
  async handleIncoming(
    rawBody: Buffer | undefined,
    signature: string | undefined,
    parsedBody: any,
  ): Promise<void> {
    try {
      this.logger.log('Webhook de WhatsApp recibido');

      const secret = this.config.get<string>('WHATSAPP_APP_SECRET');
      if (!verifyWebhookSignature(rawBody, signature, secret)) {
        this.logger.warn('Webhook de WhatsApp con firma inválida — ignorado');
        return;
      }

      const messages: InboundMessage[] =
        parsedBody?.entry?.[0]?.changes?.[0]?.value?.messages ?? [];

      if (messages.length === 0) {
        this.logger.log(
          'Webhook sin mensajes de texto (probablemente un status update) — ignorado',
        );
      }

      for (const message of messages) {
        this.logger.log(`Mensaje entrante de ${message.from}: "${message.text?.body}"`);
        if (message.type !== 'text' || !message.text?.body) continue;
        await this.handleTextMessage(message.from, message.text.body);
      }
    } catch (err) {
      this.logger.error(
        `Error procesando webhook de WhatsApp: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private async handleTextMessage(phone: string, text: string): Promise<void> {
    const tenant = await this.resolveTenant(phone, text);
    if (!tenant) {
      this.logger.log(`No se pudo identificar el club para ${phone} — se pregunta`);
      await this.whatsapp.sendFreeText(
        phone,
        'Hola! Para ayudarte necesito saber de qué club se trata — ' +
          'abrí la página de tu club y escribinos desde el botón de ' +
          'WhatsApp que aparece ahí, así te identificamos automáticamente.',
      );
      return;
    }

    this.logger.log(`Club identificado para ${phone}: ${tenant.name} (${tenant.slug})`);
    const reply = await this.answerQuestion(tenant, text);
    this.logger.log(`Respuesta generada para ${phone}: "${reply}"`);
    await this.whatsapp.sendFreeText(phone, reply);
  }

  // Usado por el demo interactivo de la landing pública — misma lógica
  // exacta que usa el bot real por WhatsApp (answerQuestion), solo que
  // acá el club se identifica por slug en vez de por conversación de
  // WhatsApp. NotFoundException de findBySlug se propaga tal cual (404).
  async answerForDemo(slug: string, question: string): Promise<string> {
    const tenant = await this.tenants.findBySlug(slug);
    return this.answerQuestion(tenant, question);
  }

  // Resuelve a qué club pertenece la conversación. Primero mira si ya
  // lo sabe (mismo teléfono, charla en curso). Si no, busca una
  // referencia al club en el mensaje — el link "Consultanos por
  // WhatsApp" de la página pública de cada club precarga el mensaje
  // con "(ref:<slug>)", que es un dato exacto, no texto libre que la
  // persona pueda escribir mal. Como respaldo, también intenta
  // interpretar el mensaje entero como si fuera el slug del club (por
  // si alguien escribe directo "demo" sin pasar por el link).
  private async resolveTenant(
    phone: string,
    text: string,
  ): Promise<{ id: string; name: string; slug: string } | null> {
    const existing = this.conversations.get(phone);
    if (existing) {
      this.conversations.touch(phone);
      return {
        id: existing.tenantId,
        name: existing.tenantName,
        slug: existing.tenantSlug,
      };
    }

    for (const slug of extractSlugCandidates(text)) {
      try {
        const tenant = await this.tenants.findBySlug(slug);
        this.conversations.set(phone, tenant);
        return tenant;
      } catch {
        // No es un slug válido, sigue probando el siguiente candidato.
      }
    }

    return null;
  }

  // Trae canchas activas del club + sus horarios semanales, únicos
  // datos que el bot necesita para contestar disponibilidad general,
  // precios y horarios. La disponibilidad exacta de un día puntual
  // (con reservas ya tomadas descontadas) sigue viviendo solo en la
  // página de reservas — el bot manda ese link en vez de duplicar esa
  // lógica acá.
  private async getClubContext(tenantId: string) {
    return this.tenantContext.withTenant(tenantId, async (client) => {
      const { rows } = await client.query(
        `select r.id, r.name, r.type, r.sena_amount,
                coalesce(
                  json_agg(
                    json_build_object(
                      'day_of_week', ar.day_of_week,
                      'start_time', ar.start_time,
                      'end_time', ar.end_time
                    ) order by ar.day_of_week, ar.start_time
                  ) filter (where ar.id is not null),
                  '[]'
                ) as rules
         from resources r
         left join availability_rules ar on ar.resource_id = r.id
         where r.tenant_id = $1 and r.active
         group by r.id
         order by r.created_at`,
        [tenantId],
      );
      return rows;
    });
  }

  private async answerQuestion(
    tenant: { id: string; name: string; slug: string },
    question: string,
  ): Promise<string> {
    const apiKey = this.config.get<string>('ANTHROPIC_API_KEY');
    if (!apiKey) {
      this.logger.warn('ANTHROPIC_API_KEY no configurado — no se puede responder');
      return 'Perdón, no puedo responder consultas en este momento. Probá más tarde.';
    }

    const webAppUrl = this.config.get<string>('WEB_APP_URL') ?? '';
    const bookingUrl = webAppUrl ? `${webAppUrl}/${tenant.slug}` : '';
    const courts = await this.getClubContext(tenant.id);

    const systemPrompt =
      `Sos el asistente de WhatsApp de "${tenant.name}", un club que usa Canchaya ` +
      'para gestionar sus reservas de canchas. Respondé SOLO con la información ' +
      'que te paso abajo en JSON — nunca inventes ni asumas un horario, precio o ' +
      'cancha que no esté ahí. day_of_week va de 0 (domingo) a 6 (sábado). Si te ' +
      'preguntan algo que no podés responder con estos datos (por ejemplo, ' +
      'disponibilidad exacta de un día puntual con reservas ya tomadas), decilo ' +
      'y mandá el link de reservas para que lo vean en vivo. Respuestas cortas, ' +
      'en español rioplatense. Nunca uses Markdown (nada de **negrita**, ' +
      '# títulos, ni listas con guiones) — es texto plano de WhatsApp, y si ' +
      'querés destacar algo usá *un solo asterisco* a cada lado, que es como ' +
      'WhatsApp interpreta la negrita de verdad.\n\n' +
      `Canchas de ${tenant.name}:\n${JSON.stringify(courts)}\n\n` +
      (bookingUrl ? `Link de reservas: ${bookingUrl}` : '');

    try {
      this.anthropic ??= new Anthropic({ apiKey });
      const response = await this.anthropic.messages.create({
        model: MODEL,
        max_tokens: 400,
        system: systemPrompt,
        messages: [{ role: 'user', content: question }],
      });
      const block = response.content[0];
      return block.type === 'text' ? block.text : 'No pude generar una respuesta.';
    } catch (err) {
      this.logger.error(
        `Error consultando a Claude: ${err instanceof Error ? err.message : err}`,
      );
      return 'Perdón, tuve un problema respondiendo tu consulta. Probá de nuevo en un rato.';
    }
  }
}
