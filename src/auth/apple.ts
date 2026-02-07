import { createRemoteJWKSet, jwtVerify } from 'jose';

export type AppleVerified = {
  sub: string;
  email?: string;
};

const APPLE_JWKS = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

export async function verifyAppleIdentityToken(params: {
  token: string;
  audience: string;
  issuer?: string;
}) : Promise<AppleVerified> {
  const issuer = params.issuer ?? 'https://appleid.apple.com';
  const { payload } = await jwtVerify(params.token, APPLE_JWKS, {
    issuer,
    audience: params.audience,
  });

  if (typeof payload.sub !== 'string') throw new Error('Apple token missing sub');
  const out: AppleVerified = { sub: payload.sub };
  if (typeof payload.email === 'string') out.email = payload.email;
  return out;
}
