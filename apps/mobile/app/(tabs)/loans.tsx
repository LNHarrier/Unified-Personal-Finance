import { useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as SecureStore from "expo-secure-store";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://10.0.2.2:3001";

export default function Loans() {
  const [items, setItems] = useState<Array<{ id: string; lender_name: string; loan_type: string; original_principal_minor: number }>>([]);
  useEffect(() => {
    SecureStore.getItemAsync("upf_token").then(async (token) => {
      if (!token) return;
      const response = await fetch(`${API_URL}/api/v1/loans`, { headers: { Authorization: `Bearer ${token}` } });
      if (response.ok) setItems((await response.json()).items);
    }).catch(() => {});
  }, []);
  return (
    <SafeAreaView style={styles.safe}>
      <Text style={styles.title}>Loans</Text>
      <ScrollView>{items.map((item) => <View key={item.id} style={styles.card}><Text style={styles.type}>{item.loan_type}</Text><Text style={styles.name}>{item.lender_name}</Text><Text style={styles.amount}>₹{(item.original_principal_minor / 100).toLocaleString("en-IN")}</Text></View>)}</ScrollView>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f4f7f4", padding: 18 },
  title: { fontSize: 30, fontWeight: "800", color: "#17332a", marginBottom: 18 },
  card: { backgroundColor: "white", borderRadius: 14, padding: 16, marginBottom: 10, borderWidth: 1, borderColor: "#e5ebe7" },
  type: { color: "#718078", textTransform: "capitalize" },
  name: { color: "#17332a", fontSize: 18, fontWeight: "800", marginTop: 4 },
  amount: { color: "#1f8059", fontWeight: "800", marginTop: 8 },
});
