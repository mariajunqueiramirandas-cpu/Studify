// Entrar: e-mail, then the 6-digit code from the same e-mail the app uses (PLT-02.1). The web never creates an
// account; sign-up needs an invite and happens in the app (SP-02).
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { sendCode, verifyCode } from '../lib/supabase.ts';
import { BrandMark, BrandText } from '../ui/brand.tsx';
import { Button, Field, TextInput } from '../ui/controls.tsx';
import { Banner } from '../ui/feedback.tsx';

export function AuthFrame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="auth">
      <main className="auth-card">
        <div className="brand">
          <BrandMark />
          <BrandText />
        </div>
        <h1 className="auth-title">{title}</h1>
        {children}
      </main>
    </div>
  );
}


const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const RESEND_SECONDS = 60;

export function SignIn({ notice }: { notice: string | null }) {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => window.clearTimeout(id);
  }, [cooldown]);

  useEffect(() => {
    document.title = 'Entrar | Painel Studify';
  }, []);

  const send = async (event?: FormEvent) => {
    event?.preventDefault();
    const address = email.trim().toLowerCase();
    if (!EMAIL.test(address)) {
      setError('Digite um e-mail válido, como voce@escola.com.');
      return;
    }
    setBusy(true);
    setError(null);
    const result = await sendCode(address).catch(() => 'sent' as const);
    setBusy(false);
    if (result === 'rate_limited') {
      setError('Muitas tentativas seguidas. Espere um minuto e peça de novo.');
      return;
    }
    setEmail(address);
    setStep('code');
    setCooldown(RESEND_SECONDS);
    window.setTimeout(() => codeRef.current?.focus(), 0);
  };

  const verify = async (value = code) => {
    if (value.length !== 6) return;
    setBusy(true);
    setError(null);
    const ok = await verifyCode(email, value).catch(() => false);
    setBusy(false);
    // On success the session listener opens the painel.
    if (!ok) setError('Código inválido ou vencido. Confira o e-mail mais recente ou peça um novo.');
  };

  return (
    <AuthFrame title={step === 'email' ? 'Entre no painel' : 'Digite o código'}>
      {notice ? (
        <div style={{ marginTop: 16 }}>
          <Banner kind="neutral">{notice}</Banner>
        </div>
      ) : null}
      {step === 'email' ? (
        <>
          <p className="auth-text">Use o mesmo e-mail da sua conta no app. Eu te mando um código de 6 dígitos.</p>
          <form className="auth-form" onSubmit={send} noValidate>
            <Field label="E-mail" error={error}>
              {({ id, describedBy, invalid }) => (
                <TextInput
                  id={id}
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  autoFocus
                  required
                />
              )}
            </Field>
            <Button type="submit" variant="primary" busy={busy}>
              Enviar código
            </Button>
          </form>
        </>
      ) : (
        <>
          <p className="auth-text">
            Se <strong>{email}</strong> tiver uma conta no Studify, o código chega em instantes. Ele vale por 1 hora.
          </p>
          <form
            className="auth-form"
            onSubmit={(e) => {
              e.preventDefault();
              void verify();
            }}
            noValidate
          >
            <Field label="Código de 6 dígitos" error={error}>
              {({ id, describedBy, invalid }) => (
                <TextInput
                  id={id}
                  ref={codeRef}
                  className="input-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={code}
                  onChange={(e) => {
                    const digits = e.target.value.replace(/\D/g, '').slice(0, 6);
                    setCode(digits);
                    if (digits.length === 6) void verify(digits);
                  }}
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                />
              )}
            </Field>
            <Button type="submit" variant="primary" busy={busy} disabled={code.length !== 6}>
              Entrar
            </Button>
            <div className="inline">
              <Button variant="ghost" size="sm" disabled={cooldown > 0 || busy} onClick={() => void send()}>
                {cooldown > 0 ? `Reenviar em ${cooldown} s` : 'Reenviar código'}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setStep('email');
                  setCode('');
                  setError(null);
                }}
              >
                Usar outro e-mail
              </Button>
            </div>
          </form>
        </>
      )}
      <p className="auth-foot">
        Ainda não tem conta? O cadastro é feito no app, com um convite de quem organiza a sua turma. <a href="/">Conheça o Studify</a>
      </p>
    </AuthFrame>
  );
}
