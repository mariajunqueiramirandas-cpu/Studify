import { Redirect } from 'expo-router';

/** `studify://practice/review` from notifications and the widget → immersive review. */
export default function PracticeReviewLink() {
  return <Redirect href="/review" />;
}
