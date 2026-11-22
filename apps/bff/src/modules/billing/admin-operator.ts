// Only use on routes protected by requireInternalService; the header is not public authentication.
export function validateAdminOperator({ request }: { request: Request }) {
  const operator = request.headers.get('x-admin-operator')
  if (operator !== null && (!operator.trim() || operator.length > 320)) {
    return Response.json({ error: 'invalid_operator' }, { status: 400 })
  }
}

export function adminOperator({ request }: { request: Request }) {
  // Older Admin proxies do not send an actor; retain their historical attribution.
  return { operatorId: request.headers.get('x-admin-operator')?.trim() || 'admin' }
}
