import { WebView } from 'react-native-webview';
import { View } from '@/components/Themed';
import type { GuestBootstrapAttempt } from '@/hooks/useGuestBootstrap';

export const GUEST_BOOTSTRAP_READY_MESSAGE = 'zhihu-guest-bootstrap-ready';

/** Keep credential values inside the WebView/native cookie stores. */
export function GuestBootstrap({
  attempt,
}: {
  attempt: GuestBootstrapAttempt;
}) {
  return (
    <View
      style={{
        width: 1,
        height: 1,
        opacity: 0,
        position: 'absolute',
        pointerEvents: 'none',
      }}
    >
      <WebView
        source={{ uri: 'https://www.zhihu.com/' }}
        sharedCookiesEnabled
        injectedJavaScript={`
          (function() {
            function ready() {
              return /(?:^|;\\s*)d_c0=[^;]+/.test(document.cookie);
            }
            function notify() {
              window.ReactNativeWebView.postMessage('${GUEST_BOOTSTRAP_READY_MESSAGE}');
            }
            if (ready()) { notify(); return; }
            var checkCookie = setInterval(function() {
              if (ready()) {
                clearInterval(checkCookie);
                notify();
              }
            }, 500);
          })();
          true;
        `}
        onMessage={(event) => {
          if (event.nativeEvent.data === GUEST_BOOTSTRAP_READY_MESSAGE) {
            attempt.complete(true);
          }
        }}
        onError={() => attempt.complete(false)}
        onHttpError={() => attempt.complete(false)}
      />
    </View>
  );
}
