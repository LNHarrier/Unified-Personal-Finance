import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { router } from "expo-router";
import * as SecureStore from "expo-secure-store";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://10.0.2.2:3001";

export default function LoginScreen() {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState("");
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    let active = true;
    SecureStore.getItemAsync("upf_token").then(async (token) => {
      if (token) {
        const response = await fetch(`${API_URL}/api/v1/users/me`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (response.ok) {
          router.replace("/(tabs)");
          return;
        }
        await SecureStore.deleteItemAsync("upf_token");
      }
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : "Could not restore saved session.");
    }).finally(() => {
      if (active) setCheckingSession(false);
    });
    return () => { active = false; };
  }, []);

  const login = async () => {
    setError("");
    try {
      const response = await fetch(`${API_URL}/api/v1/auth/${mode === "login" ? "login" : "register"}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(mode === "login" ? { email, password } : { email, password, displayName }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "Login failed");
      await SecureStore.setItemAsync("upf_token", body.token);
      if (body.user?.id) await SecureStore.setItemAsync("upf_user_id", body.user.id);
      router.replace("/(tabs)");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Login failed");
    }
  };

  if (checkingSession) {
    return <SafeAreaView style={styles.safe}><ActivityIndicator size="large" color="#1f8059" /></SafeAreaView>;
  }
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.brand}>
        <View style={styles.mark}><Text style={styles.markText}>F</Text></View>
        <Text style={styles.title}>Finova</Text>
      </View>
      <View style={styles.form}>
        <Text style={styles.heading}>{mode === "login" ? "Welcome back" : "Create account"}</Text>
        {mode === "register" && <TextInput placeholder="Display name" value={displayName} onChangeText={setDisplayName} style={styles.input} />}
        <TextInput placeholder="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" style={styles.input} />
        <TextInput placeholder="Password (at least 12 characters)" value={password} onChangeText={setPassword} secureTextEntry style={styles.input} />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Pressable style={styles.button} onPress={login}><Text style={styles.buttonText}>{mode === "login" ? "Sign in" : "Create account"}</Text></Pressable>
        <Pressable onPress={() => setMode(mode === "login" ? "register" : "login")}><Text style={styles.switch}>{mode === "login" ? "New here? Create account" : "Already have an account? Sign in"}</Text></Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f4f7f4", padding: 24, justifyContent: "center" },
  brand: { alignItems: "center", marginBottom: 28 },
  mark: { width: 48, height: 48, borderRadius: 14, backgroundColor: "#2f8f68", alignItems: "center", justifyContent: "center" },
  markText: { color: "white", fontSize: 24, fontWeight: "800" },
  title: { marginTop: 8, fontSize: 32, fontWeight: "800", color: "#17332a" },
  form: { backgroundColor: "white", borderRadius: 18, padding: 20, gap: 12, borderWidth: 1, borderColor: "#e5ebe7" },
  heading: { fontSize: 24, fontWeight: "800", color: "#17332a", marginBottom: 8 },
  input: { borderWidth: 1, borderColor: "#d8e1dc", borderRadius: 10, padding: 13, backgroundColor: "white" },
  button: { backgroundColor: "#1f8059", borderRadius: 10, padding: 14, alignItems: "center", marginTop: 4 },
  buttonText: { color: "white", fontWeight: "800" },
  error: { color: "#b33a34" },
  switch: { color: "#1f8059", textAlign: "center", fontWeight: "700", padding: 8 },
});
