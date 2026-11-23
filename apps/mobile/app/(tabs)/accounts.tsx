import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import * as SecureStore from "expo-secure-store";

const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "http://10.0.2.2:3001";

export default function Accounts() {
  const [accounts, setAccounts] = useState<Array<{ id: string; name: string; account_type: string }>>([]);
  const [name, setName] = useState("");
  const [type, setType] = useState("bank");
  const [openingBalance, setOpeningBalance] = useState("");
  const [error, setError] = useState("");
  const refresh = () => {
    SecureStore.getItemAsync("upf_token").then(async (token) => {
      if (!token) return;
      const response = await fetch(`${API_URL}/api/v1/accounts`, { headers: { Authorization: `Bearer ${token}` } });
      if (response.ok) setAccounts((await response.json()).items);
      else throw new Error("Unable to load accounts.");
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "Unable to load accounts."));
  };
  useEffect(refresh, []);
  const create = async () => {
    setError("");
    try {
      const token = await SecureStore.getItemAsync("upf_token");
      if (!token) throw new Error("Sign in again to create an account.");
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const response = await fetch(`${API_URL}/api/v1/accounts`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          name,
          accountType: type,
          currency: "INR",
          openingDate: new Date().toISOString(),
          ...(Number(openingBalance) !== 0 ? { openingBalanceMinor: Math.round(Number(openingBalance) * 100) } : {}),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message ?? "Account creation failed.");
      setName("");
      setOpeningBalance("");
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Account creation failed.");
    }
  };
  return (
    <SafeAreaView style={styles.safe}>
      <Text style={styles.title}>Accounts</Text>
      <View style={styles.form}>
        <TextInput placeholder="Account name" value={name} onChangeText={setName} style={styles.input} />
        <View style={styles.types}>{["bank","cash","credit_card","loan","investment"].map((item) => <Pressable key={item} style={[styles.chip,type===item&&styles.selected]} onPress={() => setType(item)}><Text style={type===item?styles.selectedText:styles.chipText}>{item.replace("_"," ")}</Text></Pressable>)}</View>
        <TextInput placeholder="Opening balance (₹), optional" value={openingBalance} onChangeText={setOpeningBalance} keyboardType="decimal-pad" style={styles.input} />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <Pressable style={styles.button} onPress={create}><Text style={styles.buttonText}>Create account</Text></Pressable>
      </View>
      <ScrollView>{accounts.map((account) => <View key={account.id} style={styles.card}><Text style={styles.type}>{account.account_type}</Text><Text style={styles.name}>{account.name}</Text></View>)}</ScrollView>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f4f7f4", padding: 18 },
  title: { fontSize: 30, fontWeight: "800", color: "#17332a", marginBottom: 18 },
  card: { backgroundColor: "white", borderRadius: 14, padding: 16, marginBottom: 10, borderWidth: 1, borderColor: "#e5ebe7" },
  type: { color: "#718078", textTransform: "capitalize" },
  name: { color: "#17332a", fontSize: 18, fontWeight: "800", marginTop: 4 },
  form: { backgroundColor:"white",borderRadius:14,padding:14,marginBottom:14,borderWidth:1,borderColor:"#e5ebe7",gap:10 },
  input: { borderWidth:1,borderColor:"#d8e1dc",borderRadius:9,padding:11 },
  types: { flexDirection:"row",flexWrap:"wrap",gap:6 },
  chip: { paddingVertical:7,paddingHorizontal:9,borderRadius:18,backgroundColor:"#edf1ee" },
  selected: { backgroundColor:"#1f8059" },
  chipText: { color:"#52655c",fontSize:12,textTransform:"capitalize" },
  selectedText: { color:"white",fontSize:12,textTransform:"capitalize" },
  button: { backgroundColor:"#1f8059",borderRadius:9,padding:12,alignItems:"center" },
  buttonText: { color:"white",fontWeight:"800" },
  error: { color:"#b33a34" },
});
