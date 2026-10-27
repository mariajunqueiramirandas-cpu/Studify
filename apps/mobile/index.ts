// App entry. The widget's headless task must be registered before React mounts (MEM-04),
// so it lives here instead of in a component.
import { registerReviewWidgetTaskHandler } from './src/platform/review-widget';
import 'expo-router/entry';

registerReviewWidgetTaskHandler();
