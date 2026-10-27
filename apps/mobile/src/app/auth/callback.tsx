import * as Linking from 'expo-linking';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { View } from 'react-native';
import { supabase } from '../../api/supabase';
import { SkeletonList } from '../../components';

/** `studify://auth/callback` — magic-link landing (PKCE `?code=` or implicit `#access_token=`). */
export default function AuthCallback() {
  const url = Linking.useURL();
  useEffect(() => {
    if (!url) return;
    void (async () => {
      const parsed = new URL(url.replace('#', url.includes('?') ? '&' : '?'));
      const code = parsed.searchParams.get('code');
      const access = parsed.searchParams.get('access_token');
      const refresh = parsed.searchParams.get('refresh_token');
      try {
        if (code) await supabase.auth.exchangeCodeForSession(code);
        else if (access && refresh) await supabase.auth.setSession({ access_token: access, refresh_token: refresh });
      } finally {
        router.replace('/today');
      }
    })();
  }, [url]);
  return (
    <View style={{ flex: 1, padding: 24, justifyContent: 'center' }}>
      <SkeletonList rows={3} />
    </View>
  );
}
