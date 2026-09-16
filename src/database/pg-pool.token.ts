// Token separado de database.module.ts a propósito: tenant-context.service.ts
// necesita este token, y database.module.ts necesita importar
// TenantContextService para registrarlo como provider. Si el token viviera
// en database.module.ts, ese sería un import circular entre ambos archivos
// — en CommonJS eso deja PG_POOL como undefined en uno de los dos lados
// dependiendo de qué módulo se cargue primero (ver commit que corrigió esto).
export const PG_POOL = 'PG_POOL';
