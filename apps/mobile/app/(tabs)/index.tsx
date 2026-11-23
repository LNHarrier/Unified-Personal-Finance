import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as SecureStore from "expo-secure-store";
import { router } from "expo-router";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://10.0.2.2:3001";

export default function Dashboard() {
  const [summary, setSummary] = useState({ assetsMinor: 0, liabilitiesMinor: 0, netWorthMinor: 0, incomeMinor: 0, expenseMinor: 0 });
  const [error, setError] = useState("");
  useEffect(() => {
    SecureStore.getItemAsync("upf_token").then(async (token) => {
      if (!token) return;
      const response = await fetch(`${API_URL}/api/v1/reports/summary`, { headers: { Authorization: `Bearer ${token}` } });
      if (response.ok) setSummary(await response.json());
      else throw new Error("Unable to load dashboard.");
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "Unable to load dashboard."));
  }, []);
  const money = (minor: number) => `₹${(minor / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
  const signOut = async () => {
    const token = await SecureStore.getItemAsync("upf_token");
    if (token) {
      await fetch(`${API_URL}/api/v1/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: "{}",
      });
    }
    await SecureStore.deleteItemAsync("upf_token");
    await SecureStore.deleteItemAsync("upf_user_id");
    router.replace("/");
  };
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.header}><View><Text style={styles.eyebrow}>PERSONAL FINANCE</Text><Text style={styles.title}>Dashboard</Text></View><Pressable onPress={signOut}><Text style={styles.signOut}>Sign out</Text></Pressable></View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={[styles.card, styles.primary]}>
        <Text style={styles.labelLight}>Net worth</Text>
        <Text style={styles.valueLight}>{money(summary.netWorthMinor)}</Text>
      </View>
      <View style={styles.row}>
        <View style={styles.card}><Text style={styles.label}>Assets</Text><Text style={styles.value}>{money(summary.assetsMinor)}</Text></View>
        <View style={styles.card}><Text style={styles.label}>Liabilities</Text><Text style={styles.value}>{money(summary.liabilitiesMinor)}</Text></View>
      </View>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f4f7f4", padding: 18 },
  eyebrow: { color: "#718078", letterSpacing: 1, fontWeight: "800", fontSize: 11 },
  title: { fontSize: 30, fontWeight: "800", color: "#17332a", marginBottom: 18 },
  row: { flexDirection: "row", gap: 12 },
  card: { flex: 1, backgroundColor: "white", borderRadius: 16, padding: 18, borderWidth: 1, borderColor: "#e5ebe7", marginBottom: 12 },
  primary: { backgroundColor: "#1f8059", borderColor: "#1f8059" },
  label: { color: "#718078", marginBottom: 8 },
  labelLight: { color: "#dcebe3", marginBottom: 8 },
  value: { color: "#17332a", fontSize: 20, fontWeight: "800" },
  valueLight: { color: "white", fontSize: 28, fontWeight: "800" },
  header: { flexDirection:"row",alignItems:"center",justifyContent:"space-between" },
  signOut: { color:"#1f8059",fontWeight:"700" },
  error: { color:"#b33a34",marginBottom:10 },
});
